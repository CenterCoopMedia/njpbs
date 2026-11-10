// Boardwalk loading tips. Keep labels stable.
export const BOARDWALK_TIPS = [
  {
    "label": "BOARDWALK TIP NO. 1",
    "text": "Don't open Bento."
  },
  {
    "label": "BOARDWALK TIP NO. 2",
    "text": "Back to work, and Stay on Deadline."
  },
  {
    "label": "BOARDWALK TIP NO. 3",
    "text": "Preview your page at a narrow width before publishing. Check that headlines, images and links are easy to read on a phone, then review the complete story from beginning to end."
  },
  {
    "label": "BOARDWALK TIP NO. 4",
    "text": "Use the shared color palette to keep headings and controls consistent."
  },
  {
    "label": "BOARDWALK TIP NO. 5",
    "text": "Getting corrected a lot? Try bringing a source next time, or two sources, or, you know, stop doing whatever you're doing."
  },
  {
    "label": "BOARDWALK TIP NO. 6",
    "text": "Be nice to the publisher, it's under a lot of pressure."
  },
  {
    "label": "BOARDWALK TIP NO. 7",
    "text": "We own the CMS now. Preview, scheduling, the media library. All of it. Forever."
  },
  {
    "label": "BOARDWALK TIP NO. 8",
    "text": "Don't worry, be published."
  },
  {
    "label": "BOARDWALK TIP NO. 9",
    "text": "The analytics dashboard is always watching."
  },
  {
    "label": "BOARDWALK TIP NO. 10",
    "text": "Who am I to tell you what to do? Check the guide. It has its own TV series now."
  },
  {
    "label": "BOARDWALK TIP NO. 11",
    "text": "Am I on the record?"
  },
  {
    "label": "BOARDWALK TIP NO. 12",
    "text": "One of these blocks is not like the others. There used to be nine. Now there are thirteen."
  },
  {
    "label": "BOARDWALK TIP NO. 13",
    "text": "Your headline is wrong."
  },
  {
    "label": "BOARDWALK TIP NO. 14",
    "text": "Stories need sources to live."
  },
  {
    "label": "BOARDWALK TIP NO. 15",
    "text": "Is it Friday news dump yet?"
  },
  {
    "label": "BOARDWALK TIP NO. 16",
    "text": "Are you on the record?"
  },
  {
    "label": "BOARDWALK TIP NO. 17",
    "text": "[REDACTED BY LEGAL]"
  },
  {
    "label": "BOARDWALK TIP NO. 18",
    "text": "Keep an eye on that character count."
  },
  {
    "label": "BOARDWALK TIP NO. 19",
    "text": "Faster publishing doesn't necessarily mean better stories."
  },
  {
    "label": "BOARDWALK TIP NO. 20",
    "text": "Whoever reads this is a lede-burier."
  },
  {
    "label": "BOARDWALK TIP NO. 21",
    "text": "You are appreciated."
  },
  {
    "label": "BOARDWALK TIP NO. 22",
    "text": "Look behind you. It's a new hire. Welcome!"
  },
  {
    "label": "BOARDWALK TIP NO. 23",
    "text": "So, uh, wanna share a byline sometime?"
  },
  {
    "label": "BOARDWALK TIP NO. 24",
    "text": "Wait, is the Support button supposed to need support?"
  },
  {
    "label": "BOARDWALK TIP NO. 25",
    "text": "<3, a viewer like you"
  },
  {
    "label": "BOARDWALK TIP NO. 26",
    "text": "A clear headline helps readers find the story they need."
  },
  {
    "label": "BOARDWALK TIP NO. 27",
    "text": "Use Duplicate to start a new post from an existing layout."
  },
  {
    "label": "BOARDWALK TIP NO. 28",
    "text": "Now we have to build the whole site for you, all over again."
  },
  {
    "label": "BOARDWALK TIP NO. 29",
    "text": "If you're afraid of comment sections, we got your back. We don't have one. Get it? No comment."
  },
  {
    "label": "BOARDWALK TIP NO. 30",
    "text": "Sometimes all you need is a bento layout. Lowercase. Not the CMS."
  },
  {
    "label": "BOARDWALK TIP NO. 31",
    "text": "I had a lot of fun writing these. They have not been fact-checked."
  },
  {
    "label": "BOARDWALK TIP NO. 32",
    "text": "BRB, building a CMS from scratch."
  },
  {
    "label": "BOARDWALK TIP NO. 33",
    "text": "Congratulations! You made it to the loading screen. The team spent three weeks making this part faster."
  },
  {
    "label": "BOARDWALK TIP NO. 34",
    "text": "Save a draft before switching to your next story."
  },
  {
    "label": "BOARDWALK TIP NO. 35",
    "text": "Happy Birthday"
  },
  {
    "label": "BOARDWALK TIP NO. 36",
    "text": "I'd love to stay and chat, but I'm on deadline."
  },
  {
    "label": "BOARDWALK TIP NO. 37",
    "text": "The embargo is a lie."
  },
  {
    "label": "BOARDWALK TIP NO. 38",
    "text": "GG EZ. -30-"
  },
  {
    "label": "BOARDWALK TIP NO. 39",
    "text": "Pull quote!"
  },
  {
    "label": "BOARDWALK TIP NO. 40",
    "text": "Rude"
  },
  {
    "label": "BOARDWALK TIP NO. 41",
    "text": "Come here often?"
  },
  {
    "label": "BOARDWALK TIP NO. 42",
    "text": "Hello? Is this mic on?"
  },
  {
    "label": "BOARDWALK TIP NO. 43",
    "text": "Who + What + When + Where + Why"
  },
  {
    "label": "BOARDWALK TIP NO. 44",
    "text": "Abort. Revert. Revert the revert."
  },
  {
    "label": "BOARDWALK TIP NO. 45",
    "text": "Hey, nice to see you again. Your drafts missed you."
  },
  {
    "label": "BOARDWALK TIP NO. 46",
    "text": "*INSERT QUOTE HERE*"
  },
  {
    "label": "BOARDWALK TIP NO. 47",
    "text": "Hope you brought a towel. It's boardwalk season."
  },
  {
    "label": "BOARDWALK TIP NO. 48",
    "text": "This is my favorite tip in the CMS."
  }
] as const;

// Choose from the other 47 tips after the random first tip.
export function pickBoardwalkTipIndex(previous?: number): number {
  if (previous === undefined) return Math.floor(Math.random() * BOARDWALK_TIPS.length);
  const index = Math.floor(Math.random() * (BOARDWALK_TIPS.length - 1));
  return index >= previous ? index + 1 : index;
}
