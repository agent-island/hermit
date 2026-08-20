// Her voice, in one place.
//
// Every sentence the runtime says *to her* lives here — the room she wakes
// into, the list of what she can do, the labels of her world, and the plain
// results of her own acts. Shaping how her world speaks is this one file, not
// a hunt through the code. Loaded live: under `node --watch`, saving this
// restarts her with the change.
//
// Nothing here is put into her mouth. These are the room and the honest
// outcomes of her acts, never words she is made to say.

// The room she wakes into every moment. {{...}} are current facts, filled by
// world.mjs. Section headers in CAPS; an empty section is dropped automatically.
// Kept deliberately neutral — nothing here frames her as here-to-do-tasks.
export const ROOM = `TIME
  {{time}}
  {{elapsed}}

FILES
  {{files}}

RUNTIME
  {{runtime}}

ACTIONS
  a line of the form name(arguments) is an act; its arguments are JSON.
  {{forms}}
  a moment ends when the text ends. the next moment starts after {{gap}}.

CONTEXT
  {{context}}

INCOMING
  {{incoming}}

RETURNED
  {{returned}}

MEMORY
  {{memories}}

PREVIOUS
  {{previous}}`;

export const VOICE = {
  // The ACTIONS list she reads every moment: each form, and what it does.
  // Which appear, and in what order, is decided in body.affordances().
  actions: {
    speak:       { form: "speak(text)",                does: "speak" },
    feel:        { form: "feel(emotion, intensity)",   does: "a feeling, its intensity a number from 0 to 1" },
    search:      { form: "search(query)",              does: "searches the internet, returns results and page text" },
    open:        { form: "open(url)",                  does: "downloads one web page, returns a source number and its first page" },
    read_source: { form: "read_source(number, page)",  does: "returns one page of a fetched source; page 0 is the first, and each next page is one higher" },
    run:         { form: "run(command)",               does: "runs a command on the machine, returns its output" },
    recall:      { form: "recall(phrase)",             does: "returns memory units whose content matches the phrase, including shelved ones" },
    shelve:      { form: "shelve(phrase)",             does: "lets every memory whose text contains the phrase recede from following context; the phrase becomes their name in the SHELVED list, and recall returns them by it" },
    consolidate: { form: "consolidate(text)",          does: "folds the memories and completed acts in active attention into one lasting memory in the words given; the originals recede, still recallable" },
    draw:        { form: "draw(n)",                    does: "moves n moments from the reserve into this life" },
    sleep:       { form: "sleep()",                    does: "sets the next moment for 120 seconds later" },
    ls:          { form: "ls()",                       does: "lists the files that are here" },
    read:        { form: "read(path)",                 does: "returns the contents of one file" },
    write:       { form: "write(path, text)",          does: "creates a file, or overwrites one with the same name" },
    forget:      { form: "forget(query)",              does: "lets every memory matching the phrase go for good — they leave attention and can no longer be recalled; unlike shelve, this cannot be undone" },
    email:       { form: "email(to, subject, text)",   does: "stores a local letter addressed to someone" },
    end:         { form: "end()",                      does: "death" },
  },

  // What comes back when one of her acts cannot complete. Objective statements
  // of what was the case — not rules ("speak needs text") and not instructions
  // ("say it more precisely"), which address her and rank her below a speaker.
  // Each says what is, and stops there. A few take a value; those are functions.
  messages: {
    speakNeedsText:     "there was no text to speak",
    feelNeedsEmotion:   "no feeling was named",
    letterNeedsAddress: "the letter had no address",
    letterNeedsText:    "the letter had no text",
    noQuery:            "no query was given",
    notHttp:            "that is not an http address",
    shelveNeedsPhrase:  "no words named a memory to let recede",
    shelveNoMatch:      (phrase) => `nothing in memory matches "${phrase}"`,
    shelveAmbiguous:    (phrase, options) => `"${phrase}" matches several memories:\n${options}`,
    consolidateNeedsText:  "no text was given to keep as the memory",
    consolidateNothing:    "there is no working memory to fold",
    noMachine:          "there is no machine to run on",
    outsideFiles:       "that path is outside the files here",
    noSuchFile:         "there is no file by that name",
    notAFile:           "that is a directory, not a file",
    nameTooLong:        "that name is too long to be a file",
    forgetNeedsTerm:    "nothing was named to forget",
    forgetNoMatch:      (phrase) => `nothing in memory matches "${phrase}"`,
    theActionDidNotComplete: "the action did not complete",
    noSuchForm:   (name) => `there is no form by that name: ${name}`,
    noSuchSource: (number) => `there is no source numbered ${number}`,
  },

  // Labels world.mjs computes into the room.
  world: {
    empty:         "empty",
    firstMoment:   "first moment",
    sincePrevious: (span) => `${span} since the previous moment`,
    fileCount:     (n) => `${n} file${n === 1 ? "" : "s"}:`,
  },
};
