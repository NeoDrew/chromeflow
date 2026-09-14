/**
 * Suppresses Chrome's own native "offer to save" prompts — the password
 * manager bubble ("Save login info to your Google Account?"), the address/
 * credit-card autofill save prompts, and the "Translate this page?" offer.
 * These are browser-chrome UI, not page content: they render outside the
 * tab's DOM entirely, so nothing CDP/Runtime.evaluate/content-scripts touch
 * can see or dismiss them after the fact. The only real lever is Chrome's
 * own chrome.privacy API, which turns the underlying feature off so the
 * prompt never fires in the first place, rather than reacting to it once
 * it's already on screen.
 *
 * Deliberately does NOT touch safeBrowsingEnabled, searchSuggestEnabled, or
 * spellingServiceEnabled — those aren't "a popup interrupting an automation
 * session," they're security/UX features unrelated to what this was asked
 * to fix.
 *
 * Scope note: these are per-Chrome-profile settings, not scoped to
 * chromeflow-driven tabs specifically — there's no such distinction chrome.
 * privacy can express. Turning this on means Chrome stops offering to save
 * passwords/addresses/cards, and stops offering to translate, in ALL
 * browsing in this profile, not just sessions chromeflow drives. Re-enable
 * any of these anytime in chrome://settings (Autofill and passwords /
 * Languages), or by clearing the setting here.
 *
 * Idempotent and cheap — safe to call on every service-worker wake (MV3
 * workers restart often; there's no reliable single "install" moment to
 * hook this to instead).
 */
export function suppressNativeSavePrompts(): void {
  try {
    const privacy = (chrome as unknown as {
      privacy?: {
        services?: {
          passwordSavingEnabled?: { set: (details: { value: boolean }) => void };
          autofillAddressEnabled?: { set: (details: { value: boolean }) => void };
          autofillCreditCardEnabled?: { set: (details: { value: boolean }) => void };
          translationServiceEnabled?: { set: (details: { value: boolean }) => void };
        };
      };
    }).privacy;
    const services = privacy?.services;
    if (!services) return;
    services.passwordSavingEnabled?.set({ value: false });
    services.autofillAddressEnabled?.set({ value: false });
    services.autofillCreditCardEnabled?.set({ value: false });
    services.translationServiceEnabled?.set({ value: false });
  } catch {
    // Missing "privacy" permission, or running in a context without it —
    // never let this block extension startup.
  }
}
