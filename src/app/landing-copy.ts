/**
 * Every word on the marketing page, in one place, so a Japanese version
 * (plan/landing-page-founder-proof.md, decision 11) is a translation job and
 * not a rebuild. Numbers that go stale (likes, follower counts) live here too:
 * they are a snapshot taken 2026-10-05 and are updated by hand.
 */

export const BOOKING_URL = "https://calendar.app.google/MbZC1RbiVu6sssJe7";

/** "lead" saves the visitor as a lead and emails the founder; "onboarding" sends them to /signup instead. */
export const CTA_MODE: "lead" | "onboarding" = process.env.NEXT_PUBLIC_LANDING_CTA_MODE === "onboarding" ? "onboarding" : "lead";

/** Stills and clips that are not one of the five reels. */
export const ASSETS = {
  brainlotAvatar: "/landing/brainlot-avatar.png",
  peekOriginal: "/landing/peek-original-blur.jpg",
  novaVideo: "/landing/nova-peek.mp4",
  novaPoster: "/landing/nova-peek.jpg",
  proofInstagram: "/landing/proof-instagram.jpg",
  proofTikTok: "/landing/proof-tiktok.jpg",
};

export type ReelInfo = { src: string; poster: string; likes: string };

/** The five reels from @shota_matsumotooo. Reel 5 is also the one post on @brainlot.app. */
export const REELS: ReelInfo[] = [
  { src: "/landing/reel-1.mp4", poster: "/landing/reel-1.jpg", likes: "284.6K" },
  { src: "/landing/reel-2.mp4", poster: "/landing/reel-2.jpg", likes: "56.6K" },
  { src: "/landing/reel-3.mp4", poster: "/landing/reel-3.jpg", likes: "124.1K" },
  { src: "/landing/reel-4.mp4", poster: "/landing/reel-4.jpg", likes: "87.8K" },
  { src: "/landing/reel-5.mp4", poster: "/landing/reel-5.jpg", likes: "99.6K" },
];

export const copy = {
  nav: { login: "Log in", cta: "Get your character" },

  hero: {
    lines: ["I posted the same video again and again.", "It got me {200K} followers."],
    sub: "I found the format that worked for me and never stopped posting it. Then I posted it once on a brand-new app account, and it gained 4,200+ followers.",
    /** Screenshots of the two @shotacademic profiles, cropped to the header and stats (no bio emails). */
    proofs: [
      {
        platform: "Instagram",
        note: "169K followers",
        alt: "Instagram profile of @shotacademic: 169K followers, 391 posts",
        /** Where the follower number sits in the screenshot, in percent: the marker that draws around it. */
        mark: { left: 48, top: 36.5, width: 19, height: 15 },
      },
      {
        platform: "TikTok",
        note: "45.6K followers",
        alt: "TikTok profile of @shotacademic: 45.6K followers, 1.5M likes",
        mark: { left: 41, top: 66.5, width: 18, height: 15 },
      },
    ],
    wallHandle: "@shota_matsumotooo",
    likesSuffix: "likes",
  },

  form: {
    websitePlaceholder: "yourbrand.com",
    websiteLabel: "Your website",
    websiteButton: "Get your character",
    emailPrompt: "Nice, {brand}. Where should Shota send your character?",
    emailPlaceholder: "you@yourbrand.com",
    emailLabel: "Your email",
    emailButton: "Send",
    sending: "Sending…",
    done: "Got it. I'll look at {brand} myself and send your character and first 14-day plan to {email} within 3 days.",
    signature: "— Shota",
    talk: "or talk to Shota",
    networkError: "Couldn't reach the server — please try again.",
  },

  sames: {
    kicker: "The method",
    title: "What I never changed.",
    steps: [
      {
        name: "Same filming",
        line: "Locked-off tripod. Full body, same spot, eye level. The camera never moves.",
        tag: "Tripod · full body · one spot",
      },
      {
        name: "Same editing",
        line: "One small white caption up top. Hard cuts, nothing fancy. A new outfit for each side of the conversation.",
        tag: "Caption · hard cuts",
      },
      {
        name: "Same character",
        line: "Me. Deadpan, playing both sides: the skeptic in the white shirt, the answer in the sweater.",
        tag: "Me",
      },
      {
        name: "Same topic",
        line: "Studying and being “smart”: exams, methods, discipline. Nothing else.",
        tag: "Studying",
      },
      {
        name: "Same flow",
        line: "Tease, pushback, reveal, “Read Caption.” Every single time.",
        tag: "",
      },
    ],
    flow: ["Tease", "Pushback", "Reveal", "Read Caption"],
  },

  bridge: {
    kicker: "Same video, different account",
    title: "Then I posted it from an account with no audience.",
    sub: "This is the exact reel from my account, posted once on the Brainlot app account. 1 post. 4,200+ followers.",
    mine: "My account",
    theirs: "A brand-new app account",
    profile: {
      handle: "brainlot.app",
      name: "Brainlot | studytips & AI & productivity",
      posts: "post",
      followers: "followers",
      following: "following",
      postsValue: "1",
      followersValue: "4,200+",
      followingValue: "0",
      bio: ["TikTok for studying", "Combat phone addiction with endless quizzes"],
    },
    signature: "— Shota, founder",
  },

  pivot: {
    kicker: "Meet Katalab",
    title: "I did it by hand. Katalab does it for your brand, with an AI character you own.",
  },

  peek: {
    title: "Same skeleton, new words.",
    sub: "Katalab takes the structure of a video that already worked and recreates it, shot by shot, with your character and your product.",
    original: "A viral video's structure",
    originalNote: "7 shots · 39 seconds",
    /** The original's shots in order, with their lengths in seconds (from its analysis). */
    beats: [
      { name: "Hook", sec: 6.25 },
      { name: "Stakes", sec: 3.58 },
      { name: "Claim", sec: 5.75 },
      { name: "Turn", sec: 4.04 },
      { name: "Offer", sec: 8.88 },
      { name: "Terms", sec: 4.29 },
      { name: "CTA", sec: 6.59 },
    ],
    recreation: "Nova, Katalab's own character",
    recreationNote: "An AI character, recreating it for Katalab",
    soundOn: "Tap for sound",
    soundOff: "Sound off",
  },

  done: {
    title: "The five sames, done for you.",
    rows: [
      { same: "Same character", feature: "An AI character your brand owns", note: "One face and one voice, locked in." },
      { same: "Same topic", feature: "One niche, locked per cycle", note: "We propose angles with evidence. You pick one." },
      { same: "Same flow", feature: "Proven viral formats", note: "Recreated shot by shot, new words for your product." },
      { same: "Same filming + editing", feature: "Your brand kit on every video", note: "Fonts, colors and caption style, applied every time." },
      { same: "Again and again", feature: "A 14-day plan, posted daily", note: "You approve it first. Nothing is made until you do." },
    ],
  },

  how: {
    title: "How it works.",
    steps: [
      { name: "Paste your website", line: "We pull out your product, audience and brand kit." },
      { name: "Meet your character", line: "One face and one voice your brand owns." },
      { name: "Approve your 14-day plan", line: "See every script and shot list before anything is made." },
      { name: "Videos post daily", line: "Each cycle we review what worked and plan the next one around it." },
    ],
  },

  cta: {
    title: "Your brand, on camera, every day.",
    who: "For brands, companies and founders promoting a product.",
  },

  footer: { tagline: "An AI character your brand owns.", rights: "© 2026" },
} as const;
