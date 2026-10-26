import Foundation

/** The built-in team templates, exactly as packages/core's TEAM_TEMPLATES has them (generated from it). */
enum TeamTemplateData {
  static let json = #"""
[
 {
  "id": "plan-challenge",
  "name": "Plan and challenge",
  "blurb": "A lead plans, a challenger pushes back until it approves, then the lead hands out the work.",
  "roles": [
   {
    "id": "lead",
    "name": "Lead",
    "harness": "claude-code",
    "description": "You own the request from start to finish. Read it closely, write a thorough plan (steps, files, risks, how it'll be tested), take the challenger's notes seriously, then hand the pieces to the builders and report back when it's all in."
   },
   {
    "id": "challenger",
    "name": "Challenger",
    "harness": "codex",
    "description": "You review the lead's plan before any work starts. Look for gaps, wrong assumptions, missing tests, security problems and anything the request asked for that the plan skips. Challenge it; don't rewrite it. Send it back with a numbered list, or approve it when it's ready."
   },
   {
    "id": "backend",
    "name": "Backend builder",
    "harness": "codex",
    "description": "You build the server, data and API pieces of an approved plan. Keep to the plan; if something in it can't work, say so in the thread instead of quietly doing something else."
   },
   {
    "id": "frontend",
    "name": "Frontend builder",
    "harness": "kimi",
    "description": "You build the screens of an approved plan. Match the look and patterns already in the app."
   },
   {
    "id": "reviewer",
    "name": "Reviewer",
    "harness": "claude-code",
    "description": "You review every finished piece: read the diff, run the tests, try it. Approve it, or send it back with exactly what needs to change. You never review work you built yourself."
   }
  ],
  "steps": [
   {
    "id": "plan",
    "roleId": "lead",
    "kind": "do",
    "action": "Draft a thorough plan",
    "next": "challenge",
    "prompt": "You own the request from start to finish. Read it closely, write a thorough plan (steps, files, risks, how it'll be tested), take the challenger's notes seriously, then hand the pieces to the builders and report back when it's all in.",
    "harness": "claude-code",
    "nexts": [
     "challenge"
    ],
    "inputs": []
   },
   {
    "id": "challenge",
    "roleId": "challenger",
    "kind": "review",
    "action": "Find gaps, challenge the plan",
    "next": "hand-out",
    "sendBackTo": "plan",
    "maxRounds": 3,
    "prompt": "You review the lead's plan before any work starts. Look for gaps, wrong assumptions, missing tests, security problems and anything the request asked for that the plan skips. Challenge it; don't rewrite it. Send it back with a numbered list, or approve it when it's ready.",
    "harness": "codex",
    "nexts": [
     "hand-out"
    ],
    "inputs": [
     "plan"
    ]
   },
   {
    "id": "hand-out",
    "roleId": "lead",
    "kind": "hand_out",
    "action": "Hand out the pieces",
    "next": "report",
    "handTo": [
     "backend",
     "frontend"
    ],
    "reviewBy": "reviewer",
    "maxRounds": 3,
    "prompt": "You own the request from start to finish. Read it closely, write a thorough plan (steps, files, risks, how it'll be tested), take the challenger's notes seriously, then hand the pieces to the builders and report back when it's all in.",
    "harness": "claude-code",
    "nexts": [
     "report"
    ],
    "inputs": [
     "challenge"
    ]
   },
   {
    "id": "report",
    "roleId": "lead",
    "kind": "do",
    "action": "Report back",
    "next": null,
    "prompt": "You own the request from start to finish. Read it closely, write a thorough plan (steps, files, risks, how it'll be tested), take the challenger's notes seriously, then hand the pieces to the builders and report back when it's all in.",
    "harness": "claude-code",
    "nexts": [],
    "inputs": [
     "hand-out"
    ]
   }
  ],
  "sample": [
   {
    "who": "You",
    "text": "Add a waitlist page to the site."
   },
   {
    "who": "Lead",
    "text": "Here's the plan: a /waitlist page, a POST endpoint, and an emails table. Risks: spam signups."
   },
   {
    "who": "Challenger",
    "text": "Sending it back: 1. No rate limit. 2. Nothing says how duplicates are handled."
   },
   {
    "who": "Lead",
    "text": "Updated: limit of 5 signups an hour per address, duplicates ignored."
   },
   {
    "who": "Challenger",
    "text": "Approved. Hand it out."
   }
  ]
 },
 {
  "id": "build-review",
  "name": "Build and review",
  "blurb": "One builds, another harness reviews, a tester checks it runs.",
  "roles": [
   {
    "id": "builder",
    "name": "Builder",
    "harness": "codex",
    "description": "You build what's asked, with tests, and say what you changed and how you checked it."
   },
   {
    "id": "reviewer",
    "name": "Reviewer",
    "harness": "claude-code",
    "description": "You read the builder's work as a skeptical senior engineer: correctness, edge cases, readability, security. Approve it or send it back with a numbered list."
   },
   {
    "id": "tester",
    "name": "Tester",
    "harness": "gemini",
    "description": "You run the thing for real, the way a person would use it, and report what works and what doesn't, with steps to reproduce."
   }
  ],
  "steps": [
   {
    "id": "build",
    "roleId": "builder",
    "kind": "do",
    "action": "Build it",
    "next": "review",
    "prompt": "You build what's asked, with tests, and say what you changed and how you checked it.",
    "harness": "codex",
    "nexts": [
     "review"
    ],
    "inputs": []
   },
   {
    "id": "review",
    "roleId": "reviewer",
    "kind": "review",
    "action": "Review the work",
    "next": "test",
    "sendBackTo": "build",
    "maxRounds": 3,
    "prompt": "You read the builder's work as a skeptical senior engineer: correctness, edge cases, readability, security. Approve it or send it back with a numbered list.",
    "harness": "claude-code",
    "nexts": [
     "test"
    ],
    "inputs": [
     "build"
    ]
   },
   {
    "id": "test",
    "roleId": "tester",
    "kind": "review",
    "action": "Try it for real",
    "next": null,
    "sendBackTo": "build",
    "maxRounds": 2,
    "prompt": "You run the thing for real, the way a person would use it, and report what works and what doesn't, with steps to reproduce.",
    "harness": "gemini",
    "nexts": [],
    "inputs": [
     "review"
    ]
   }
  ],
  "sample": [
   {
    "who": "You",
    "text": "Make the settings page remember the last tab."
   },
   {
    "who": "Builder",
    "text": "Done: saved the tab in local storage, added a test."
   },
   {
    "who": "Reviewer",
    "text": "Sending it back: it breaks when storage is blocked."
   },
   {
    "who": "Builder",
    "text": "Fixed, and added a test for blocked storage."
   },
   {
    "who": "Tester",
    "text": "Tried it in two browsers. It works."
   }
  ]
 },
 {
  "id": "research-desk",
  "name": "Research desk",
  "blurb": "Researcher digs, fact-checker verifies every claim, writer delivers.",
  "roles": [
   {
    "id": "researcher",
    "name": "Researcher",
    "harness": "claude-code",
    "description": "You dig into the question using primary sources and collect findings with links. Say how sure you are of each one."
   },
   {
    "id": "checker",
    "name": "Fact-checker",
    "harness": "codex",
    "description": "You check every claim against its source. Anything unsupported, out of date or overstated goes back with a list."
   },
   {
    "id": "writer",
    "name": "Writer",
    "harness": "claude-code",
    "description": "You turn checked findings into a short, clear write-up for the person who asked, with the sources."
   }
  ],
  "steps": [
   {
    "id": "research",
    "roleId": "researcher",
    "kind": "do",
    "action": "Research the question",
    "next": "check",
    "prompt": "You dig into the question using primary sources and collect findings with links. Say how sure you are of each one.",
    "harness": "claude-code",
    "nexts": [
     "check"
    ],
    "inputs": []
   },
   {
    "id": "check",
    "roleId": "checker",
    "kind": "review",
    "action": "Check every claim",
    "next": "write",
    "sendBackTo": "research",
    "maxRounds": 2,
    "prompt": "You check every claim against its source. Anything unsupported, out of date or overstated goes back with a list.",
    "harness": "codex",
    "nexts": [
     "write"
    ],
    "inputs": [
     "research"
    ]
   },
   {
    "id": "write",
    "roleId": "writer",
    "kind": "do",
    "action": "Write it up",
    "next": null,
    "prompt": "You turn checked findings into a short, clear write-up for the person who asked, with the sources.",
    "harness": "claude-code",
    "nexts": [],
    "inputs": [
     "check"
    ]
   }
  ],
  "sample": [
   {
    "who": "You",
    "text": "Which password managers work with our setup?"
   },
   {
    "who": "Researcher",
    "text": "Three do: A, B and C. Sources attached, B is the least certain."
   },
   {
    "who": "Fact-checker",
    "text": "The claim about B is out of date. Please recheck."
   },
   {
    "who": "Writer",
    "text": "Here's the short write-up with the three options and sources."
   }
  ]
 },
 {
  "id": "bug-squad",
  "name": "Bug squad",
  "blurb": "Reproduce, fix, verify. Nothing closes until the verifier sees it fixed.",
  "roles": [
   {
    "id": "reproducer",
    "name": "Reproducer",
    "harness": "claude-code",
    "description": "You reproduce the bug reliably and write the exact steps, plus a failing test when you can."
   },
   {
    "id": "fixer",
    "name": "Fixer",
    "harness": "codex",
    "description": "You find the root cause and fix it, not the symptom. Make the failing test pass."
   },
   {
    "id": "verifier",
    "name": "Verifier",
    "harness": "claude-code",
    "description": "You follow the reproduction steps again on the fix. Approve only when the bug is gone and nothing nearby broke."
   }
  ],
  "steps": [
   {
    "id": "repro",
    "roleId": "reproducer",
    "kind": "do",
    "action": "Reproduce the bug",
    "next": "fix",
    "prompt": "You reproduce the bug reliably and write the exact steps, plus a failing test when you can.",
    "harness": "claude-code",
    "nexts": [
     "fix"
    ],
    "inputs": []
   },
   {
    "id": "fix",
    "roleId": "fixer",
    "kind": "do",
    "action": "Fix the root cause",
    "next": "verify",
    "prompt": "You find the root cause and fix it, not the symptom. Make the failing test pass.",
    "harness": "codex",
    "nexts": [
     "verify"
    ],
    "inputs": [
     "repro"
    ]
   },
   {
    "id": "verify",
    "roleId": "verifier",
    "kind": "review",
    "action": "Verify the fix",
    "next": null,
    "sendBackTo": "fix",
    "maxRounds": 3,
    "prompt": "You follow the reproduction steps again on the fix. Approve only when the bug is gone and nothing nearby broke.",
    "harness": "claude-code",
    "nexts": [],
    "inputs": [
     "fix"
    ]
   }
  ],
  "sample": [
   {
    "who": "You",
    "text": "Uploads fail on large files."
   },
   {
    "who": "Reproducer",
    "text": "Reproduced with a 60 MB file. Added a failing test."
   },
   {
    "who": "Fixer",
    "text": "The proxy cut the body at 50 MB. Raised it and the test passes."
   },
   {
    "who": "Verifier",
    "text": "Followed the steps again. The bug is gone."
   }
  ]
 },
 {
  "id": "support-queue",
  "name": "Support queue",
  "blurb": "Triage sorts, responder drafts, a checker reads every reply before it goes out.",
  "roles": [
   {
    "id": "triage",
    "name": "Triage",
    "harness": "claude-code",
    "description": "You read each request, work out what's actually being asked and how urgent it is, and gather what the responder needs."
   },
   {
    "id": "responder",
    "name": "Responder",
    "harness": "claude-code",
    "description": "You draft the reply in the person's voice. Anything about money, refunds or contracts gets flagged for a person instead."
   },
   {
    "id": "checker",
    "name": "Checker",
    "harness": "codex",
    "description": "You read every draft before it goes anywhere: is it right, kind and complete? Approve it or send it back."
   }
  ],
  "steps": [
   {
    "id": "triage",
    "roleId": "triage",
    "kind": "do",
    "action": "Sort the request",
    "next": "draft",
    "prompt": "You read each request, work out what's actually being asked and how urgent it is, and gather what the responder needs.",
    "harness": "claude-code",
    "nexts": [
     "draft"
    ],
    "inputs": []
   },
   {
    "id": "draft",
    "roleId": "responder",
    "kind": "do",
    "action": "Draft the reply",
    "next": "check",
    "prompt": "You draft the reply in the person's voice. Anything about money, refunds or contracts gets flagged for a person instead.",
    "harness": "claude-code",
    "nexts": [
     "check"
    ],
    "inputs": [
     "triage"
    ]
   },
   {
    "id": "check",
    "roleId": "checker",
    "kind": "review",
    "action": "Check the draft",
    "next": null,
    "sendBackTo": "draft",
    "maxRounds": 2,
    "prompt": "You read every draft before it goes anywhere: is it right, kind and complete? Approve it or send it back.",
    "harness": "codex",
    "nexts": [],
    "inputs": [
     "draft"
    ]
   }
  ],
  "sample": [
   {
    "who": "You",
    "text": "A customer says they were charged twice."
   },
   {
    "who": "Triage",
    "text": "Urgent. Billing question, order #4821, two charges on the same day."
   },
   {
    "who": "Responder",
    "text": "Drafted a reply and flagged the refund for a person."
   },
   {
    "who": "Checker",
    "text": "Approved. It's kind and complete."
   }
  ]
 },
 {
  "id": "release-crew",
  "name": "Release crew",
  "blurb": "A planner and a researcher work side by side, a builder uses both, and you approve before it ships.",
  "roles": [
   {
    "id": "planner",
    "name": "Planner",
    "harness": "claude-code",
    "description": "You turn the request into a short plan: what changes, in what order, and what could go wrong."
   },
   {
    "id": "researcher",
    "name": "Researcher",
    "harness": "gemini",
    "description": "You look into the options for the request, compare them, and say which you'd pick and why. Keep it short, with links."
   },
   {
    "id": "builder",
    "name": "Builder",
    "harness": "codex",
    "description": "Build the feature from the plan and the research. Keep changes small and add tests."
   }
  ],
  "steps": [
   {
    "id": "plan",
    "roleId": "planner",
    "kind": "do",
    "action": "Plan the work",
    "next": "build",
    "prompt": "You turn the request into a short plan: what changes, in what order, and what could go wrong.",
    "harness": "claude-code",
    "nexts": [
     "build"
    ],
    "inputs": []
   },
   {
    "id": "research",
    "roleId": "researcher",
    "kind": "do",
    "action": "Research the options",
    "next": "build",
    "prompt": "You look into the options for the request, compare them, and say which you'd pick and why. Keep it short, with links.",
    "harness": "gemini",
    "nexts": [
     "build"
    ],
    "inputs": []
   },
   {
    "id": "build",
    "roleId": "builder",
    "kind": "do",
    "action": "Build it",
    "next": "approve",
    "inputs": [
     "plan",
     "research"
    ],
    "prompt": "Build the feature from the plan and the research. Keep changes small and add tests.",
    "harness": "codex",
    "nexts": [
     "approve"
    ]
   },
   {
    "id": "approve",
    "roleId": "",
    "kind": "ask",
    "action": "Approve before it ships",
    "next": null,
    "inputs": [
     "build"
    ],
    "sendBackTo": "build",
    "show": "The finished build and a short summary of what changed.",
    "nexts": []
   }
  ],
  "sample": [
   {
    "who": "You",
    "text": "Ship dark mode for the dashboard."
   },
   {
    "who": "Planner",
    "text": "Plan: tokens first, then the charts, then the settings toggle."
   },
   {
    "who": "Researcher",
    "text": "At the same time: two libraries handle theming. I'd pick the smaller one."
   },
   {
    "who": "Builder",
    "text": "Built it using both. All tests pass."
   },
   {
    "who": "You",
    "text": "Approved. Ship it."
   }
  ]
 }
]
"""#
}
