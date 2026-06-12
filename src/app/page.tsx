import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.intro}>
          <p className={styles.kicker}>Baboo</p>
          <h1>Resolve support tickets from your own knowledge.</h1>
          <p>
            AI-drafted, citation-grounded answers from your docs and past
            tickets — reviewed by your team before they ship. Sign up, create
            your organization, and connect a knowledge source.
          </p>
        </div>
        <div className={styles.ctas}>
          <Link href="/sign-up" className={styles.primary}>
            Get started
          </Link>
          <Link href="/sign-in" className={styles.secondary}>
            Sign in
          </Link>
        </div>
      </main>
    </div>
  );
}
