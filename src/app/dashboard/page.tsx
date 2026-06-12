import Link from "next/link";
import { redirect } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { getAppContext } from "@/lib/auth/context";
import styles from "./dashboard.module.css";

/**
 * Authenticated app shell — the empty dashboard a user lands on after sign-up +
 * org creation (BAB-16 acceptance). Product surfaces (knowledge base, inbox,
 * answers) fill the empty state in later milestones.
 */
export default async function DashboardPage() {
  const ctx = await getAppContext();
  if (!ctx) redirect("/sign-in");
  if (!ctx.activeOrg) redirect("/onboarding");

  const { user, activeOrg } = ctx;

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.logo}>Baboo</span>
          <span
            className={styles.org}
            title={`Organization: ${activeOrg.name}`}
          >
            {activeOrg.name}
          </span>
        </div>
        <div className={styles.account}>
          <span className={styles.email}>{user.email}</span>
          <UserButton />
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.empty}>
          <h1 className={styles.title}>You&apos;re all set.</h1>
          <p className={styles.subtitle}>
            <strong>{activeOrg.name}</strong> is ready. This is your workspace —
            connect a knowledge source to start deflecting support tickets.
          </p>
          <div className={styles.actions}>
            <Link href="/dashboard/leads" className={styles.secondary}>
              View leads
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
