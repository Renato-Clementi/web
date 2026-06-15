#!/usr/bin/env python3
"""
BAB-81 — probe Odoo to confirm `maintenance` module is installed and inspect
the models/fields needed to wire Manutenzione programmata -> Maintenance.

READ-ONLY. Confirms:
  - ir.module.module state for 'maintenance'
  - maintenance.equipment / maintenance.request fields (preventive recurrence)
  - maintenance.team existence
  - helpdesk.ticket exposes any maintenance link field
  - existing helpdesk config: team 4, tag 4 (Manutenzione programmata),
    stage 9 (Pianificato), SLA 4, FSM project 91

Env: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
"""
import os
import re
import sys
import xmlrpc.client


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
    db, uid, key, models = connect()
    print(f"connected uid={uid}\n")

    # 1) module state
    mods = call(models, db, uid, key, "ir.module.module", "search_read",
                [[("name", "in", ["maintenance", "helpdesk", "industry_fsm", "sale_management"])]],
                {"fields": ["name", "state", "shortdesc"]})
    print("=== modules ===")
    for m in mods:
        print(f"  {m['name']:20} {m['state']:12} {m['shortdesc']}")
    print()

    maint_installed = any(m["name"] == "maintenance" and m["state"] == "installed" for m in mods)
    if not maint_installed:
        print("!!! maintenance NOT installed -> cannot wire integration. STOP.")
        return

    # 2) maintenance.equipment fields
    def fields_of(model, names=None):
        try:
            f = call(models, db, uid, key, model, "fields_get", [],
                     {"attributes": ["string", "type", "relation", "required"]})
        except Exception as e:
            print(f"  (fields_get {model} failed: {e})")
            return {}
        if names:
            return {k: v for k, v in f.items() if k in names}
        return f

    print("=== maintenance.equipment (selected fields) ===")
    eq = fields_of("maintenance.equipment",
                   ["name", "partner_id", "owner_user_id", "category_id", "maintenance_team_id",
                    "company_id", "location", "serial_no", "note", "product_id", "partner_ref"])
    for k, v in sorted(eq.items()):
        print(f"  {k:22} {v['type']:10} rel={v.get('relation')} req={v.get('required')}")
    print()

    print("=== maintenance.request (recurrence + link fields) ===")
    rq = fields_of("maintenance.request",
                   ["name", "equipment_id", "maintenance_type", "schedule_date", "duration",
                    "repeat_interval", "repeat_unit", "repeat_type", "maintenance_team_id",
                    "user_id", "owner_user_id", "category_id", "stage_id", "company_id",
                    "recurring_maintenance", "request_date", "description"])
    for k, v in sorted(rq.items()):
        sel = ""
        print(f"  {k:24} {v['type']:10} rel={v.get('relation')} req={v.get('required')}")
    print()

    # selection options for maintenance_type / repeat_unit / repeat_type
    for fld in ["maintenance_type", "repeat_unit", "repeat_type"]:
        try:
            allf = call(models, db, uid, key, "maintenance.request", "fields_get", [[fld]],
                        {"attributes": ["selection", "type"]})
            print(f"  {fld} selection: {allf.get(fld, {}).get('selection')}")
        except Exception as e:
            print(f"  {fld}: {e}")
    print()

    # 3) maintenance.team list
    teams = call(models, db, uid, key, "maintenance.team", "search_read", [[]],
                 {"fields": ["id", "name"]})
    print("=== maintenance.team ===")
    for t in teams:
        print(f"  {t['id']}: {t['name']}")
    print()

    # categories
    cats = call(models, db, uid, key, "maintenance.equipment.category", "search_read", [[]],
                {"fields": ["id", "name"]})
    print("=== maintenance.equipment.category ===")
    for c in cats:
        print(f"  {c['id']}: {c['name']}")
    print()

    # 4) helpdesk.ticket maintenance link?
    print("=== helpdesk.ticket maintenance-related fields ===")
    ht = call(models, db, uid, key, "helpdesk.ticket", "fields_get", [],
              {"attributes": ["string", "type", "relation"]})
    found = {k: v for k, v in ht.items()
             if "maintenance" in k.lower() or (v.get("relation") or "").startswith("maintenance")}
    if found:
        for k, v in found.items():
            print(f"  {k:28} {v['type']:10} rel={v.get('relation')}")
    else:
        print("  (no native maintenance link field on helpdesk.ticket)")
    print()

    # 5) existing helpdesk config sanity
    print("=== helpdesk config sanity ===")
    team = call(models, db, uid, key, "helpdesk.team", "read", [[4]],
                {"fields": ["id", "name", "use_fsm", "project_id"]})
    print("  team4:", team)
    tag = call(models, db, uid, key, "helpdesk.tag", "read", [[4]], {"fields": ["id", "name"]})
    print("  tag4:", tag)
    stage = call(models, db, uid, key, "helpdesk.stage", "read", [[9]], {"fields": ["id", "name"]})
    print("  stage9:", stage)
    try:
        sla = call(models, db, uid, key, "helpdesk.sla", "read", [[4]],
                   {"fields": ["id", "name", "time", "stage_id", "tag_ids"]})
        print("  sla4:", sla)
    except Exception as e:
        print("  sla4 err:", e)
    proj = call(models, db, uid, key, "project.project", "read", [[91]],
                {"fields": ["id", "name", "is_fsm"]})
    print("  project91:", proj)
    print()


if __name__ == "__main__":
    main()
