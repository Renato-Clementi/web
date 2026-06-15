#!/usr/bin/env python3
"""
BAB-85 — probe Odoo org data for the 10 helpdesk routing candidate users.

For each candidate uid: res.users (name/login/active), linked hr.employee
(department_id, job_title, job_id), and membership in the routing-relevant
security groups. Output is a compact report used to derive the BAB-78 routing
mapping + member_ids proposal. READ-ONLY.

Env: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
"""
import os
import re
import sys
import xmlrpc.client

CANDIDATES = [13, 310, 15, 14, 24, 303, 34, 309, 6, 294]

# group xml_ids whose membership informs routing
GROUP_XMLIDS = [
    "sales_team.group_sale_salesman",
    "sales_team.group_sale_salesman_all_leads",
    "sales_team.group_sale_manager",
    "industry_fsm.group_fsm_user",
    "industry_fsm.group_fsm_manager",
    "industry_fsm.group_fsm_dispatcher",
    "maintenance.group_equipment_manager",
    "helpdesk.group_helpdesk_user",
    "helpdesk.group_helpdesk_manager",
    "project.group_project_user",
]


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

    # resolve group xml_ids -> res.groups ids + label
    groups = {}  # res.groups id -> short label
    for xmlid in GROUP_XMLIDS:
        mod, name = xmlid.split(".")
        rec = call(models, db, uid, key, "ir.model.data", "search_read",
                   [[("module", "=", mod), ("name", "=", name), ("model", "=", "res.groups")]],
                   {"fields": ["res_id"]})
        if rec:
            groups[rec[0]["res_id"]] = xmlid
    print("resolved groups:", groups, "\n")

    # users
    users = call(models, db, uid, key, "res.users", "read",
                 [CANDIDATES], {"fields": ["id", "name", "login", "active", "groups_id", "employee_id"]})
    users_by_id = {u["id"]: u for u in users}

    # employees for these users
    emps = call(models, db, uid, key, "hr.employee", "search_read",
                [[("user_id", "in", CANDIDATES)]],
                {"fields": ["id", "name", "user_id", "department_id", "job_title", "job_id", "work_email"]})
    emp_by_user = {}
    for e in emps:
        u = e["user_id"]
        if isinstance(u, list):
            emp_by_user[u[0]] = e

    for cid in CANDIDATES:
        u = users_by_id.get(cid)
        if not u:
            print(f"uid {cid}: NOT FOUND")
            continue
        e = emp_by_user.get(cid)
        dept = e["department_id"][1] if e and e.get("department_id") else "-"
        job_title = (e.get("job_title") if e else None) or "-"
        job_id = e["job_id"][1] if e and e.get("job_id") else "-"
        active = "" if u.get("active") else " [INACTIVE]"
        member_groups = [groups[g] for g in u.get("groups_id", []) if g in groups]
        print(f"uid {cid}: {u['name']} <{u['login']}>{active}")
        print(f"    dept={dept} | job_title={job_title} | job_id={job_id}")
        print(f"    routing-groups: {member_groups if member_groups else '(none)'}")
    print()


if __name__ == "__main__":
    main()
