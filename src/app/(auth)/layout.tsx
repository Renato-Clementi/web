import styles from "./auth.module.css";

/** Centering shell for the provider-rendered sign-in / sign-up widgets. */
export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <main className={styles.screen}>{children}</main>;
}
