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
// begins beside what just happened, without a framework-authored self-description.
//
// XML tags are boundaries only. They prevent a command result, a memory and an
// intention from becoming an ambiguous wall of prose; they do not assign a role
// or tell the model what kind of person to become.
export const ROOM = `<state>
<continuity>
  <intentions>
    {{intentions}}
  </intentions>

  <memory>
    {{memories}}
  </memory>

  <shelved>
    {{shelved}}
  </shelved>

</continuity>

<faculties>
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
    inner_speech:{ form: "inner_speech(text)", tagged: "<inner_speech>text</inner_speech>", does: "" },
    // Historical names remain executable but are no longer presented as
    // faculties. They preserve old lives without shaping a new continuation.
    think:       { form: "think(text)", tagged: "<think>text</think>", does: "inner speech" },
    identify:    { form: "identify(text)", tagged: "<identify>text</identify>", does: "identity" },
    speak_aloud: { form: "speak_aloud(text)", tagged: "<speak_aloud>text</speak_aloud>", does: "" },
    feel:        { form: "feel(emotion, intensity)", tagged: '<feel emotion="emotion" intensity="intensity"></feel>', does: "intensity is a number from 0 to 1" },
    search:      { form: "search(query)", tagged: "<search>query</search>", does: "searches the internet, returns results and page text" },
    open:        { form: "open(url)", tagged: "<open>url</open>", does: "downloads one web page, returns a source number and its first page" },
    read_source: { form: "read_source(number, page)", tagged: '<read_source number="number" page="page"></read_source>', does: "returns one page of a fetched source; page 0 is the first, and each next page is one higher" },
    run:         { form: "run(command)", tagged: "<run>command</run>", does: "returns output" },
    remember:    { form: "remember(kind, name, text)", tagged: '<remember kind="kind" name="name">text</remember>', does: "keeps text as an active memory named name" },
    restore:     { form: "restore(name)", tagged: "<restore>name</restore>", does: "returns a shelved memory to the present" },
    recall:      { form: "recall(phrase)", tagged: "<recall>phrase</recall>", does: "includes shelved memories" },
    revise:      { form: "revise(name, text)", tagged: '<revise name="name">text</revise>', does: "the earlier wording stays in the record" },
    shelve:      { form: "shelve(name)", tagged: "<shelve>name</shelve>", does: "removes the named memory from the present; restore can return it" },
    consolidate: { form: "consolidate(name, text)", tagged: '<consolidate name="name">text</consolidate>', does: "keeps text as a memory and shelves the active experience under name" },
    intend:      { form: "intend(goal, success, cue, under, name)", tagged: '<intend name="name" success="success" cue="cue" under="under">goal</intend>', does: "keeps goal active under name until resolved; under names its parent intention" },
    progress:    { form: "progress(intention, evidence, next, cue)", tagged: '<progress intention="intention" next="next" cue="cue">evidence</progress>', does: "" },
    resolve:     { form: "resolve(intention, outcome, evidence)", tagged: '<resolve intention="intention" outcome="outcome">evidence</resolve>', does: "" },
    draw:        { form: "draw(n)", tagged: "<draw>n</draw>", does: "adds n reserved moments to the remaining moments" },
    continue:    { form: "continue()", tagged: "<continue/>", does: "carry on into the next moment" },
    sleep:       { form: "sleep()", tagged: "<sleep/>", does: "sets an explicit return after the configured rest" },
    ls:          { form: "ls()", tagged: "<ls/>", does: "lists the files that are here" },
    read:        { form: "read(path)", tagged: "<read>path</read>", does: "returns the contents of one file" },
    write:       { form: "write(path, text)", tagged: '<write path="path">text</write>', does: "creates or replaces the file at path with text" },
    forget:      { form: "forget(name)", tagged: "<forget>name</forget>", does: "the memory cannot be restored or recalled" },
    email:       { form: "email(to, subject, text)", tagged: '<email to="to" subject="subject">text</email>', does: "stores a local letter addressed to someone" },
    end:         { form: "end()", tagged: "<end/>", does: "death" },
  },

  // What comes back when one of her acts cannot complete. Objective statements
  // of what was the case — not rules ("speak needs text") and not instructions
  // ("say it more precisely"), which address her and rank her below a speaker.
  // Each says what is, and stops there. A few take a value; those are functions.
  messages: {
    innerSpeechNeedsText:"there were no words of inner speech",
    identityNeedsText:  "there was no identity text",
    rememberNeedsKind:  "no kind was named for the memory",
    rememberNeedsText:  "there was no text for the memory",
    reviseNeedsMemory:  "no name was given for the memory to revise",
    reviseNeedsText:    "there was no revised memory text",
    reviseNoMatch:      (name) => `no memory is named "${name}"`,
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
    shelveNeedsName:    "no name was given for the memory to let recede",
    shelveNoMatch:      (name) => `no present memory is named "${name}"`,
    restoreNeedsName:   "no name was given for the memory to restore",
    restoreNoMatch:     (name) => `no shelved memory is named "${name}"`,
    consolidateNeedsText:  "no text was given to keep as the memory",
    consolidateNothing:    "there is no working memory to fold",
    noMachine:          "there is no machine to run on",
    outsideFiles:       "that path is outside the files here",
    noSuchFile:         "there is no file by that name",
    notAFile:           "that is a directory, not a file",
    nameTooLong:        "that name is too long to be a file",
    forgetNeedsTerm:    "no name was given to forget",
    forgetNoMatch:      (name) => `no memory is named "${name}"`,
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
