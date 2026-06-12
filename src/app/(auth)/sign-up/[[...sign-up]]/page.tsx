import { SignUp } from "@clerk/nextjs";

/**
 * Catch-all sign-up route. Clerk handles account creation + email verification,
 * then redirects to /onboarding where the new user names their organization.
 */
export default function SignUpPage() {
  return <SignUp signInUrl="/sign-in" forceRedirectUrl="/onboarding" />;
}
