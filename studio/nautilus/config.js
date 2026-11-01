/**
 * Nautilus settings for whoever hosts the game.
 *
 * web3formsKey   Access key from https://web3forms.com. Sign-ups are emailed
 *                to the address the key belongs to. Leave empty to turn the
 *                crew sign-up off, which keeps the form visible but sends nothing.
 * privacyContact Email address people can write to about their data.
 * repo           Repository linked from the game.
 * learnMoreUrl   Optional. A link shown under each codex entry for people
 *                who want courses or deeper material. Leave empty to hide.
 * learnMoreLabel Text for that link.
 * earlyArt       Optional. Path, relative to the studio page, of a picture
 *                for the early access card, such as "nautilus/art/nautilus.png".
 *                Leave empty for no picture.
 */
window.NAUTILUS_CONFIG = {
  web3formsKey: "",
  privacyContact: "",
  repo: "https://github.com/aitrustalliance/trp",
  learnMoreUrl: "",
  learnMoreLabel: "Go further",
  earlyArt: "",
};
