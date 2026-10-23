// The intents the organizer sorts every braindump into. Order = section order in the organized doc.
// keywords: words that point to a category, used by the rule-based categorizer and listed in Claude's prompt.
export const CATEGORIES = [
  { id: "todo", label: "To-dos", unit: ["to-do", "to-dos"], emoji: "✅", hint: "something the user intends or plans to do: tasks, errands, reminders, shopping, appointments and meetings ('meeting with Rohan at 1'), scheduled plans ('walk in Central Park at 5 pm'), and things they'd like to do later ('wondering if I could read Atomic Habits tonight')",
    keywords: [
      "buy", "call", "email", "send", "book", "submit", "pay", "schedule", "fix", "finish", "renew", "review", "reply",
      "remind", "plan", "prepare", "clean", "order", "cancel", "arrange", "organize", "task", "chore", "errand",
      "reminder", "deadline", "checklist", "priority", "appointment", "meeting", "assignment", "urgent", "important",
      "overdue", "pending", "purchase", "e-mail", "netmail", "telephone", "phone", "call up", "ring", "mail", "post",
      "reserve", "repair", "mend", "complete", "reexamine", "answer", "respond", "set up", "ready", "gear up",
      "make clean", "call off", "fix up", "organise", "coordinate", "undertaking", "project", "job", "date",
      "engagement", "group meeting", "get together", "pressing",
    ],
  },
  { id: "idea", label: "Ideas", unit: ["idea", "ideas"], emoji: "💡", hint: "a new idea, plan, project concept, or 'what if'",
    keywords: [
      "idea", "concept", "proposal", "suggestion", "invention", "hypothesis", "vision", "brainstorm", "notion",
      "imagine", "invent", "propose", "conception", "construct", "innovation", "brainwave", "whim", "whimsy",
      "whimsey", "conceive of", "ideate", "envisage", "contrive", "devise", "formulate", "suggest",
    ],
  },
  { id: "link", label: "Saved", unit: ["saved link", "saved links"], emoji: "🔖", hint: "a website, article, tool, or video link saved for later",
    keywords: [
      "article", "website", "tutorial", "podcast", "blog", "newsletter", "bookmark", "resource", "tool", "video",
      "paper", "read", "watch", "web site", "internet site", "site", "web log", "newssheet", "video recording",
    ],
  },
  { id: "inspiration", label: "Inspiration", unit: ["inspiration", "inspirations"], emoji: "🎨", hint: "visual or design references: UI, color palettes, typography, moodboards, outfits, interiors",
    keywords: [
      "inspiration", "palette", "typography", "font", "layout", "aesthetic", "design", "illustration", "style",
      "color", "texture", "gradient", "interior", "outfit", "reference", "fount", "typeface", "esthetic", "designing",
      "colour", "coloring", "colouring", "expressive style", "vogue", "trend",
    ],
  },
  { id: "moment", label: "Moments", unit: ["moment", "moments"], emoji: "📷", hint: "photos or videos of the user's life, places, food, people",
    keywords: [
      "photo", "picture", "sunset", "trip", "vacation", "memory", "dinner", "lunch", "party", "celebration", "weekend",
      "view", "walk", "family", "friend", "photograph", "pic", "exposure", "image", "sundown", "holiday", "luncheon",
      "tiffin", "jubilation", "scene", "vista", "panorama", "walking", "family unit",
    ],
  },
  { id: "note", label: "Notes", unit: ["note", "notes"], emoji: "📝", hint: "thoughts, feelings, observations, journal-like reflections, facts to remember",
    keywords: [
      "thought", "feeling", "reflection", "observation", "fact", "lesson", "insight", "mood", "journal", "feel",
      "realize", "notice", "wonder", "learn", "contemplation", "rumination", "musing", "reflexion", "thoughtfulness",
      "diary", "moral", "experience", "recognize", "recognise", "realise", "detect", "observe", "discover", "inquire",
      "enquire",
    ],
  },
  { id: "file", label: "Files", unit: ["file", "files"], emoji: "📎", hint: "documents and files kept for reference",
    keywords: [
      "document", "file", "pdf", "invoice", "receipt", "contract", "spreadsheet", "resume", "presentation", "ticket",
      "written document", "papers", "certificate", "certification", "credential", "credentials", "form", "voucher",
      "report", "written report", "commercial document", "legal document", "official document", "data file", "bill",
      "curriculum vitae", "cv",
    ],
  },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]];
export const categoryOf = (id: string) => CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 2];
