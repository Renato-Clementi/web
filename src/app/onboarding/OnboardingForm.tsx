"use client";

import { useActionState } from "react";
import { createOrgAction, type CreateOrgState } from "./actions";
import styles from "./onboarding.module.css";

const INITIAL: CreateOrgState = {};

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(createOrgAction, INITIAL);

  return (
    <form action={formAction} className={styles.form}>
      <label className={styles.label} htmlFor="org-name">
        Organization name
      </label>
      <input
        id="org-name"
        name="name"
        type="text"
        required
        minLength={2}
        maxLength={120}
        autoFocus
        placeholder="Acme Inc."
        className={styles.input}
        aria-describedby={state.error ? "org-name-error" : undefined}
      />
      {state.error ? (
        <p id="org-name-error" role="alert" className={styles.error}>
          {state.error}
        </p>
      ) : null}
      <button type="submit" className={styles.submit} disabled={pending}>
        {pending ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}
