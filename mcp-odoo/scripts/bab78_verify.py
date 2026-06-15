#!/usr/bin/env python3
"""
BAB-78 verify — create one unassigned helpdesk ticket per casistica tag in
team 4, confirm the base.automation auto-assigns the expected user, then unlink
the test tickets. READ/WRITE on helpdesk.ticket only (no admin needed).

Env: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
"""
import os, re, sys, xmlrpc.client

TEAM_ID = 4
EXPECT = {3: 13, 4: 14, 5: 34, 6: 24}  # tag -> expected user_id


def base_url():
    return re.sub(r"/odoo/?$", "", os.environ["ODOO_URL"].rstrip("/"))


def connect():
    base, db = base_url(), os.environ["ODOO_DB"]
    key = os.environ.get("ODOO_ADMIN_API_KEY") or os.environ["ODOO_API_KEY"]
    user = os.environ.get("ODOO_ADMIN_USER") or os.environ["ODOO_USER"]
    uid = xmlrpc.client.ServerProxy(f"{base}/xmlrpc/2/common").authenticate(db, user, key, {})
    if not uid:
        sys.exit("AUTH FAILED")
    return db, uid, key, xmlrpc.client.ServerProxy(f"{base}/xmlrpc/2/object")


def call(m, db, uid, key, model, method, args, kw=None):
    return m.execute_kw(db, uid, key, model, method, args, kw or {})


def main():
    db, uid, key, m = connect()
    print(f"connected uid={uid}\n")
    created, ok = [], True
    try:
        for tag, exp in EXPECT.items():
            tid = call(m, db, uid, key, "helpdesk.ticket", "create", [{
                "name": f"[BAB-78 VERIFY] tag {tag}",
                "team_id": TEAM_ID,
                "tag_ids": [(6, 0, [tag])],
            }])
            created.append(tid)
            rec = call(m, db, uid, key, "helpdesk.ticket", "read", [[tid]],
                       {"fields": ["id", "user_id", "tag_ids", "team_id"]})[0]
            assignee = rec["user_id"][0] if rec.get("user_id") else None
            status = "PASS" if assignee == exp else "FAIL"
            if status == "FAIL":
                ok = False
            print(f"  tag {tag}: ticket {tid} -> user_id={assignee} (expected {exp})  [{status}]")
    finally:
        if created:
            call(m, db, uid, key, "helpdesk.ticket", "unlink", [created])
            print(f"\ncleanup: unlinked test tickets {created}")
    print("\nRESULT:", "ALL PASS" if ok else "SOME FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
