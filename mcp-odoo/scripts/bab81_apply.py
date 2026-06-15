#!/usr/bin/env python3
"""
BAB-81 — Manutenzione programmata -> Maintenance: cablaggio integrazione.

Third casistica of BAB-70. Unlike Sales (sale_order_id) and FSM
(helpdesk_ticket_id), Odoo provides NO native helpdesk<->maintenance bridge, so
we wire it ourselves, mirroring how the other two integrations surface their link
on the ticket:

  durable artifacts (idempotent, created by --apply)
    1. maintenance.team  "Assistenza Baboo - Manutenzione Clienti"
    2. helpdesk.ticket.x_maintenance_equipment_id  (m2o maintenance.equipment)
       helpdesk.ticket.x_maintenance_request_id    (m2o maintenance.request)
    3. ir.actions.server "Crea piano manutenzione preventiva", bound to
       helpdesk.ticket (appears in the form Action menu). When run on a
       Manutenzione programmata ticket it:
         - links/creates a maintenance.equipment (asset cliente) from partner
         - creates a PREVENTIVE recurring maintenance.request
           (recurring_maintenance, repeat_interval=1, repeat_unit=year,
            repeat_type=forever) on the dedicated team
         - writes both links back onto the ticket and moves it to
           stage Pianificato (9)

  on-site periodic interventions reuse FSM project 91 "INTERVENTI DI
  MANUTENZIONE" (already the FSM target); the maintenance plan is the
  preventive scheduler, FSM tasks are the executions.

It is operator-invoked (NOT a base.automation that fires on every ticket): the
recurrence interval / team / asset are per-customer decisions the operator sets,
so auto-firing a forever-recurring plan on creation would be wrong. The server
action uses safe defaults the operator can edit on the generated request.

Modes:
    --check     rights + config sanity (read-only)
    --smoke     live E2E: create throwaway ticket+equipment+request, verify,
                then DELETE everything created (cleanup)
    --apply     create the durable team + fields + server action (idempotent)
    --verify    confirm the durable artifacts exist

Env (required): ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
Env (optional): ODOO_ADMIN_API_KEY / ODOO_ADMIN_USER (admin grant for
                ir.model.fields / ir.actions.server create; see BAB-84/BAB-65)
"""
import os
import re
import sys
import xmlrpc.client

TEAM_ID = 4                 # helpdesk team "Assistenza Baboo"
TAG_MANUTENZIONE = 4        # helpdesk.tag "Manutenzione programmata"
STAGE_PIANIFICATO = 9       # helpdesk.stage "Pianificato"
FSM_PROJECT = 91            # "INTERVENTI DI MANUTENZIONE"
MAINT_TEAM_NAME = "Assistenza Baboo - Manutenzione Clienti"
SERVER_ACTION_NAME = "Crea piano manutenzione preventiva (BAB-81)"

FIELD_EQUIP = "x_maintenance_equipment_id"
FIELD_REQ = "x_maintenance_request_id"


def base_url() -> str:
    return re.sub(r"/odoo/?$", "", os.environ["ODOO_URL"].rstrip("/"))


def connect():
    base = base_url()
    db = os.environ["ODOO_DB"]
    key = os.environ.get("ODOO_ADMIN_API_KEY") or os.environ["ODOO_API_KEY"]
    user = os.environ.get("ODOO_ADMIN_USER") or os.environ["ODOO_USER"]
    uid = xmlrpc.client.ServerProxy(f"{base}/xmlrpc/2/common").authenticate(db, user, key, {})
    if not uid:
        sys.exit(f"AUTH FAILED for {user} on {base}/{db}")
    models = xmlrpc.client.ServerProxy(f"{base}/xmlrpc/2/object")
    return db, uid, key, models


def call(models, db, uid, key, model, method, args, kw=None):
    return models.execute_kw(db, uid, key, model, method, args, kw or {})


# ---------------------------------------------------------------------------
def model_id_of(c, model):
    ids = c("ir.model", "search", [[("model", "=", model)]])
    return ids[0] if ids else None


def ensure_maint_team(c):
    ids = c("maintenance.team", "search", [[("name", "=", MAINT_TEAM_NAME)]])
    if ids:
        return ids[0], False
    tid = c("maintenance.team", "create", [{"name": MAINT_TEAM_NAME}])
    return tid, True


def find_field(c, name):
    ids = c("ir.model.fields", "search",
            [[("model", "=", "helpdesk.ticket"), ("name", "=", name)]])
    return ids[0] if ids else None


def ensure_field(c, hd_model_id, name, label, relation):
    fid = find_field(c, name)
    if fid:
        return fid, False
    fid = c("ir.model.fields", "create", [{
        "name": name,
        "model_id": hd_model_id,
        "model": "helpdesk.ticket",
        "field_description": label,
        "ttype": "many2one",
        "relation": relation,
        "state": "manual",
    }])
    return fid, True


def server_action_code(maint_team_id):
    # Runs on selected helpdesk.ticket records (env, records available).
    # safe_eval: no imports, no `fields`; use datetime; no attr-assign (use write).
    return f"""
for record in records:
    if record.{FIELD_REQ}:
        continue
    partner = record.partner_id
    equip = record.{FIELD_EQUIP}
    if not equip:
        equip = env['maintenance.equipment'].create({{
            'name': (partner.name or record.name or 'Asset') + ' - Manutenzione',
            'partner_id': partner.id if partner else False,
            'owner_user_id': record.user_id.id if record.user_id else False,
            'maintenance_team_id': {maint_team_id},
            'note': record.name,
        }})
        record.write({{'{FIELD_EQUIP}': equip.id}})
    req = env['maintenance.request'].create({{
        'name': 'Manutenzione preventiva - ' + (partner.name if partner else (record.name or '')),
        'equipment_id': equip.id,
        'maintenance_type': 'preventive',
        'recurring_maintenance': True,
        'repeat_interval': 1,
        'repeat_unit': 'year',
        'repeat_type': 'forever',
        'maintenance_team_id': {maint_team_id},
        'schedule_date': datetime.datetime.now(),
        'owner_user_id': record.user_id.id if record.user_id else False,
        'description': 'Generato da ticket helpdesk: ' + (record.name or ''),
    }})
    record.write({{'{FIELD_REQ}': req.id, 'stage_id': {STAGE_PIANIFICATO}}})
"""


def ensure_server_action(c, hd_model_id, maint_team_id):
    ids = c("ir.actions.server", "search", [[("name", "=", SERVER_ACTION_NAME)]])
    code = server_action_code(maint_team_id)
    if ids:
        # keep code in sync (idempotent update of the body)
        c("ir.actions.server", "write", [ids, {"code": code}])
        return ids[0], False
    aid = c("ir.actions.server", "create", [{
        "name": SERVER_ACTION_NAME,
        "model_id": hd_model_id,
        "state": "code",
        "code": code,
        "binding_model_id": hd_model_id,
        "binding_type": "action",
    }])
    return aid, True


# ---------------------------------------------------------------------------
def cmd_check(c):
    print("=== rights ===")
    for m in ("ir.model.fields", "ir.actions.server", "maintenance.equipment",
              "maintenance.request", "maintenance.team"):
        ok = c(m, "check_access_rights", ["create"], {"raise_exception": False})
        print(f"  create {m:24} {ok}")
    print("\n=== config ===")
    print("  team4:", c("helpdesk.team", "read", [[TEAM_ID]],
                        {"fields": ["name", "use_fsm", "project_id"]}))
    print("  tag4:", c("helpdesk.tag", "read", [[TAG_MANUTENZIONE]], {"fields": ["name"]}))
    print("  stage9:", c("helpdesk.stage", "read", [[STAGE_PIANIFICATO]], {"fields": ["name"]}))
    print("  fsm proj91:", c("project.project", "read", [[FSM_PROJECT]],
                            {"fields": ["name", "is_fsm"]}))


def cmd_smoke(c):
    print("=== SMOKE E2E (create -> verify -> cleanup) ===")
    created = {"ticket": [], "equipment": [], "request": []}
    try:
        # pick any partner to attach
        pid = c("res.partner", "search", [[("customer_rank", ">", 0)]], {"limit": 1}) \
            or c("res.partner", "search", [[]], {"limit": 1})
        pid = pid[0]
        partner = c("res.partner", "read", [[pid]], {"fields": ["name"]})[0]["name"]
        print(f"  partner: {pid} {partner}")

        maint_team = ensure_maint_team(c)[0]

        tkt = c("helpdesk.ticket", "create", [{
            "name": "[SMOKE BAB-81] Manutenzione programmata test",
            "team_id": TEAM_ID,
            "tag_ids": [(6, 0, [TAG_MANUTENZIONE])],
            "partner_id": pid,
        }])
        created["ticket"].append(tkt)
        print(f"  ticket created: {tkt}")

        equip = c("maintenance.equipment", "create", [{
            "name": f"{partner} - Manutenzione (SMOKE)",
            "partner_id": pid,
            "maintenance_team_id": maint_team,
            "note": "SMOKE BAB-81",
        }])
        created["equipment"].append(equip)
        print(f"  equipment created: {equip}")

        req = c("maintenance.request", "create", [{
            "name": f"Manutenzione preventiva - {partner} (SMOKE)",
            "equipment_id": equip,
            "maintenance_type": "preventive",
            "recurring_maintenance": True,
            "repeat_interval": 1,
            "repeat_unit": "year",
            "repeat_type": "forever",
            "maintenance_team_id": maint_team,
        }])
        created["request"].append(req)
        print(f"  request created: {req}")

        # link + move stage
        c("helpdesk.ticket", "write", [[tkt], {"stage_id": STAGE_PIANIFICATO}])

        # verify
        r = c("maintenance.request", "read", [[req]],
              {"fields": ["name", "equipment_id", "maintenance_type",
                          "recurring_maintenance", "repeat_interval", "repeat_unit",
                          "repeat_type", "maintenance_team_id", "stage_id"]})[0]
        t = c("helpdesk.ticket", "read", [[tkt]], {"fields": ["name", "stage_id"]})[0]
        print("\n  VERIFY request:", r)
        print("  VERIFY ticket :", t)
        assert r["maintenance_type"] == "preventive", "not preventive"
        assert r["recurring_maintenance"] is True, "not recurring"
        assert r["repeat_unit"] == "year" and r["repeat_interval"] == 1
        assert r["equipment_id"][0] == equip, "equipment link broken"
        assert t["stage_id"][0] == STAGE_PIANIFICATO, "ticket not Pianificato"
        print("\n  E2E ASSERTIONS PASSED")
    finally:
        print("\n  --- cleanup ---")
        for req in created["request"]:
            c("maintenance.request", "unlink", [[req]]); print(f"  deleted request {req}")
        for eq in created["equipment"]:
            c("maintenance.equipment", "unlink", [[eq]]); print(f"  deleted equipment {eq}")
        for tk in created["ticket"]:
            c("helpdesk.ticket", "unlink", [[tk]]); print(f"  deleted ticket {tk}")
        print("  cleanup complete")


def cmd_apply(c):
    print("=== APPLY durable wiring ===")
    hd = model_id_of(c, "helpdesk.ticket")
    if not hd:
        sys.exit("helpdesk.ticket model not found")

    team, new = ensure_maint_team(c)
    print(f"  maintenance.team id={team} ({'created' if new else 'exists'}) [{MAINT_TEAM_NAME}]")

    feq, neq = ensure_field(c, hd, FIELD_EQUIP, "Asset manutenzione (BAB-81)", "maintenance.equipment")
    print(f"  field {FIELD_EQUIP} id={feq} ({'created' if neq else 'exists'})")
    freq, nreq = ensure_field(c, hd, FIELD_REQ, "Piano manutenzione (BAB-81)", "maintenance.request")
    print(f"  field {FIELD_REQ} id={freq} ({'created' if nreq else 'exists'})")

    aid, na = ensure_server_action(c, hd, team)
    print(f"  server action id={aid} ({'created' if na else 'updated'}) [{SERVER_ACTION_NAME}]")
    print("\nAPPLY complete. Run --verify to confirm.")


def cmd_verify(c):
    print("=== VERIFY durable artifacts ===")
    team = c("maintenance.team", "search_read", [[("name", "=", MAINT_TEAM_NAME)]],
             {"fields": ["id", "name"]})
    print("  team:", team)
    for name in (FIELD_EQUIP, FIELD_REQ):
        f = c("ir.model.fields", "search_read",
              [[("model", "=", "helpdesk.ticket"), ("name", "=", name)]],
              {"fields": ["id", "name", "ttype", "relation"]})
        print(f"  field {name}:", f)
    act = c("ir.actions.server", "search_read", [[("name", "=", SERVER_ACTION_NAME)]],
            {"fields": ["id", "name", "state", "binding_model_id", "binding_type"]})
    print("  server action:", act)
    ok = bool(team) and find_field(c, FIELD_EQUIP) and find_field(c, FIELD_REQ) and bool(act)
    print("\n  ALL PRESENT" if ok else "\n  MISSING ARTIFACTS")


def main():
    db, uid, key, models = connect()
    c = lambda *a, **k: call(models, db, uid, key, *a, **k)
    print(f"connected uid={uid}\n")
    if "--smoke" in sys.argv:
        cmd_smoke(c)
    elif "--apply" in sys.argv:
        cmd_apply(c)
    elif "--verify" in sys.argv:
        cmd_verify(c)
    else:
        cmd_check(c)


if __name__ == "__main__":
    main()
