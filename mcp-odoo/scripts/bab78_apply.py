#!/usr/bin/env python3
"""
BAB-78 — Odoo Helpdesk "Assistenza Baboo" (team id=4) auto-routing per casistica.

Creates one `base.automation` server rule per ticket-type tag so that a newly
created/updated helpdesk ticket is auto-assigned to the competent function when
it is still unassigned. Idempotent: a rule is identified by its `name`; if it
already exists the script leaves it untouched (and reports it).

  tag id=3  Assistenza telefonica    -> 1st-level phone support
  tag id=4  Manutenzione programmata -> Maintenance function
  tag id=5  Intervento in campo      -> FSM dispatcher
  tag id=6  Preventivo               -> Sales (Plutus handoff)

WHY a script (and not the MCP connector): creating `base.automation` /
`ir.actions.server` requires Odoo *Administration: Settings* rights. `baboobot`
(uid 305) does NOT have them today (see BAB-67 / BAB-65). Run this with admin
credentials once the grant is in place:

    ODOO_ADMIN_API_KEY=<admin user api key>   # preferred (reusable)
  or temporarily point ODOO_USER / ODOO_API_KEY at an admin login.

Usage:
    python3 mcp-odoo/scripts/bab78_apply.py --dry-run      # validate, change nothing
    python3 mcp-odoo/scripts/bab78_apply.py --apply        # create the rules

Env (required): ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
Env (optional): ODOO_ADMIN_API_KEY (used in place of ODOO_API_KEY if present),
                ODOO_ADMIN_USER     (login for the admin key, default ODOO_USER)

The function -> Odoo-user mapping below is an ORG decision (BAB-78 question to
CEO). Fill TEAM4_ROUTING with real user ids before --apply. The script refuses
to create a rule whose target is still None.
"""
import os
import re
import sys
import xmlrpc.client

TEAM_ID = 4

# tag_id -> {"label": human label, "user_id": Odoo res.users id or None}
# user_id stays None until the CEO confirms staffing (BAB-78). --apply will
# refuse any rule with user_id is None; --dry-run lists them as PENDING.
TEAM4_ROUTING = {
    3: {"label": "Assistenza telefonica -> 1st-level phone support", "user_id": None},
    4: {"label": "Manutenzione programmata -> Maintenance",          "user_id": None},
    5: {"label": "Intervento in campo -> FSM dispatcher",            "user_id": None},
    6: {"label": "Preventivo -> Sales (Plutus handoff)",             "user_id": None},
}

# member_ids to set on team 4 (balanced assignment fallback). Empty until CEO
# confirms; --apply leaves member_ids untouched when this list is empty.
TEAM4_MEMBER_IDS = []  # e.g. [13, 24, 34]

RULE_NAME = "BAB-78 routing: {label}"


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


def main():
    apply = "--apply" in sys.argv
    dry = "--dry-run" in sys.argv or not apply
    db, uid, key, models = connect()
    print(f"connected uid={uid} mode={'APPLY' if apply else 'DRY-RUN'}")

    # --- permission gate (the BAB-67 blocker) ---------------------------------
    perms = {}
    for m in ("base.automation", "ir.actions.server"):
        perms[m] = call(models, db, uid, key, m, "check_access_rights", ["create"],
                        {"raise_exception": False})
    print("create rights:", perms)
    if not all(perms.values()):
        print("BLOCKED: missing Administration/Settings rights -> see BAB-67. "
              "Re-run with ODOO_ADMIN_API_KEY once granted.")
        if apply:
            sys.exit(2)

    model_id = call(models, db, uid, key, "ir.model", "search",
                    [[("model", "=", "helpdesk.ticket")]])
    if not model_id:
        sys.exit("helpdesk.ticket model not found")
    model_id = model_id[0]
    tag_field = call(models, db, uid, key, "ir.model.fields", "search",
                     [[("model", "=", "helpdesk.ticket"), ("name", "=", "tag_ids")]])
    tag_field = tag_field[0] if tag_field else None

    # validate tags exist
    existing_tags = set(call(models, db, uid, key, "helpdesk.tag", "search", [[]]))

    plan = []
    for tag_id, cfg in TEAM4_ROUTING.items():
        name = RULE_NAME.format(label=cfg["label"])
        exists = call(models, db, uid, key, "base.automation", "search",
                      [[("name", "=", name)]]) if perms["base.automation"] else []
        status = "EXISTS" if exists else (
            "PENDING (no user_id)" if cfg["user_id"] is None else "CREATE")
        if tag_id not in existing_tags:
            status = f"SKIP (tag {tag_id} missing)"
        plan.append((tag_id, name, cfg["user_id"], status))
        print(f"  tag {tag_id}: {status}  -> user_id={cfg['user_id']}  [{name}]")

    if dry:
        print("\nDRY-RUN: no changes. Fill TEAM4_ROUTING user ids + run --apply.")
        return

    for tag_id, name, user_id, status in plan:
        if status != "CREATE":
            continue
        domain = (f"[('team_id','=',{TEAM_ID}),"
                  f"('tag_ids','in',[{tag_id}]),('user_id','=',False)]")
        code = (f"for record in records:\n"
                f"    if not record.user_id:\n"
                f"        record.write({{'user_id': {user_id}}})")
        vals = {
            "name": name,
            "model_id": model_id,
            "state": "code",
            "code": code,
            "trigger": "on_create_or_write",
            "filter_domain": domain,
            "active": True,
        }
        if tag_field:
            vals["trigger_field_ids"] = [(6, 0, [tag_field])]
        rid = call(models, db, uid, key, "base.automation", "create", [vals])
        print(f"  CREATED base.automation id={rid} for tag {tag_id}")

    if TEAM4_MEMBER_IDS:
        call(models, db, uid, key, "helpdesk.team", "write",
             [[TEAM_ID], {"member_ids": [(6, 0, TEAM4_MEMBER_IDS)]}])
        print(f"  team {TEAM_ID} member_ids set -> {TEAM4_MEMBER_IDS}")
    else:
        print("  member_ids untouched (TEAM4_MEMBER_IDS empty)")

    print("\nAPPLY complete. Verify in Odoo: Helpdesk > Configuration > Automation Rules.")


if __name__ == "__main__":
    main()
