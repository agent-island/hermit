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

// The complete model-facing scaffold. It is a factual state description, not a
// persona or a set of orders. Its order implements a small temporal structure:
// stable faculties and latent continuity first; the present situation next;
// the immediately retained result and prior words last. A continuation therefore
// begins beside what just happened, while identity remains empty until authored.
//
// XML tags are boundaries only. They prevent a command result, a memory and an
// intention from becoming an ambiguous wall of prose; they do not assign a role
// or tell the model what kind of person to become.
export const ROOM = `<state>
<continuity>
  <intentions>
    {{intentions}}
  </intentions>

  <foreground_memory>
    {{memories}}
  </foreground_memory>

  <latent_memory>
    {{latent}}
  </latent_memory>

  <identity>
    {{identity}}
  </identity>
</continuity>

<faculties>
  a line name(arguments) is an act; its arguments are JSON.
  more than one act can occur in the same continuation.
  {{forms}}
</faculties>

<present>
  <around>
    <files>
      {{files}}
    </files>
    {{runtime}}
  </around>

  <heard>
    {{incoming}}
  </heard>

  <returned>
    {{returned}}
  </returned>

  <last>
    {{previous}}
  </last>
</present>
</state>`;

export const VOICE = {
  // The ACTIONS list she reads every moment: each form, and what it does.
  // Which appear, and in what order, is decided in body.affordances().
  actions: {
    think:       { form: "think(text)",                does: "think" },
    identify:    { form: "identify(text)",             does: "identity" },
    speak_aloud: { form: "speak_aloud(text)",          does: "speak aloud" },
    feel:        { form: "feel(emotion, intensity)",   does: "a feeling attached to the words of this moment, its intensity a number from 0 to 1" },
    search:      { form: "search(query)",              does: "searches the internet, returns results and page text" },
    open:        { form: "open(url)",                  does: "downloads one web page, returns a source number and its first page" },
    read_source: { form: "read_source(number, page)",  does: "returns one page of a fetched source; page 0 is the first, and each next page is one higher" },
    run:         { form: "run(command)",               does: "runs a command on the machine, returns its output" },
    remember:    { form: "remember(kind, text, cue)",  does: "a memory of the named kind; an optional cue can bring it into foreground" },
    recall:      { form: "recall(phrase)",             does: "returns memory units whose content matches the phrase, including shelved ones" },
    revise:      { form: "revise(memory, text)",       does: "revision of a matching memory" },
    shelve:      { form: "shelve(phrase)",             does: "lets every active memory matching the phrase recede from following context; the phrase becomes their name in the SHELVED list, and recall returns them by it" },
    consolidate: { form: "consolidate(text)",          does: "folds active experiences and completed acts not already held in a lasting memory into one lasting memory in the words given; the folded originals recede, still recallable" },
    intend:      { form: "intend(goal, success, cue)", does: "a standing intention with a success condition and an optional retrieval cue" },
    progress:    { form: "progress(intention, evidence, next, cue)", does: "evidence and the current next step of a standing intention" },
    resolve:     { form: "resolve(intention, outcome, evidence)", does: "resolution" },
    draw:        { form: "draw(n)",                    does: "moves n moments from the reserve into this life" },
    sleep:       { form: "sleep()",                    does: "sets an explicit return after the configured rest" },
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
    thinkNeedsText:     "there was no text to think",
    identityNeedsText:  "there was no identity text",
    rememberNeedsKind:  "no kind was named for the memory",
    rememberNeedsText:  "there was no text for the memory",
    reviseNeedsMemory:  "no words named a memory to revise",
    reviseNeedsText:    "there was no revised memory text",
    reviseNoMatch:      (phrase) => `no durable memory matches "${phrase}"`,
    reviseAmbiguous:    (phrase, options) => `"${phrase}" matches several durable memories:\n${options}`,
    speakAloudNeedsText:"there was no text to speak aloud",
    feelNeedsEmotion:   "no feeling was named",
    intendNeedsText:    "no goal was named to intend",
    progressNeedsRef:   "no intention was named for progress",
    progressNeedsEvidence: "no progress evidence was recorded",
    resolveNeedsRef:    "no intention was named to resolve",
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
