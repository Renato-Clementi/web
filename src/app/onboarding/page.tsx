import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/auth/context";
import { OnboardingForm } from "./OnboardingForm";
import styles from "./onboarding.module.css";

/**
 * First-run org creation. Reached right after sign-up. If the user is somehow
 * not signed in we bounce to /sign-in; if they already have an org we forward
 * to /dashboard so this page is never a dead end.
 */
export default async function OnboardingPage() {
  const ctx = await getAppContext();
  if (!ctx) redirect("/sign-in");
  if (ctx.activeOrg) redirect("/dashboard");

  return (
    <main className={styles.screen}>
      <section className={styles.card}>
        <p className={styles.kicker}>Welcome to Baboo</p>
        <h1 className={styles.title}>Create your organization</h1>
        <p className={styles.subtitle}>
          Your organization is the workspace your team and knowledge base live
          in. You can rename it later.
        </p>
        <OnboardingForm />
      </section>
    </main>
  );
}
