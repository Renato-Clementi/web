import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <section className={styles.card}>
        <p className={styles.kicker}>Baboo</p>
        <h1 className={styles.title}>The app is running.</h1>
        <p className={styles.subtitle}>
          Engineering foundations are in place. This placeholder confirms that a
          fresh clone boots locally. Product UI lands here next.
        </p>
        <p className={styles.meta}>
          Next.js · TypeScript · App Router — see <code>README.md</code> for the
          conventions.
        </p>
      </section>
    </main>
  );
}
