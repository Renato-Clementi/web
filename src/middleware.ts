/**
 * Clerk auth middleware. Public routes (landing, sign-in, sign-up) render for
 * anyone; everything under /dashboard and /onboarding requires a session and
 * redirects to sign-in otherwise.
 *
 * One of only three files allowed to import the auth provider directly (with
 * the root <ClerkProvider> and src/lib/auth/identity.ts) — see
 * docs/adr/0001-auth-provider.md.
 */
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/onboarding(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ico|webp|woff2?|ttf|otf|map)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
