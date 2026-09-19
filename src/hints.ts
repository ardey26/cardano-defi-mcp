/**
 * How a "you have not configured this yet" error phrases its next step.
 *
 * The same adapter serves two very different servers. The hosted, keyless one
 * has no onboarding tools, so telling its caller to "call configure" would be a
 * lie; the local CLI server does, and there the exact tool call is the most
 * useful thing an error can carry. The CLI entry points switch this on.
 */

let onboarding = false;

export function enableOnboardingHints(): void {
  onboarding = true;
}

export function onboardingHintsEnabled(): boolean {
  return onboarding;
}

/** Pick the phrasing that matches the server the caller is actually talking to. */
export function nextStep(whenOnboarding: string, whenPlain: string): string {
  return onboarding ? whenOnboarding : whenPlain;
}
