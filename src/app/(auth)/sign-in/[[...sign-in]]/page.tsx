import { SignIn } from "@clerk/nextjs";

/**
 * Catch-all sign-in route. Clerk renders the full flow (email/password, magic
 * link, social, MFA) and handles session creation. After sign-in it sends the
 * user to /dashboard, which redirects to /onboarding if they have no org yet.
 */
export default function SignInPage() {
  return <SignIn signUpUrl="/sign-up" forceRedirectUrl="/dashboard" />;
}
