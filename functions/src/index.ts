import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GameState, StoryGenre } from "./types/gameState";

// --- Initialization ---
// This simplified initialization works for both emulator and deployed environments.
admin.initializeApp();
const db = admin.firestore();

// --- Gemini AI Setup ---
// We will get the key from environment variables, which we'll set for the deployment.
const GEMINI_API_KEY = process.env.GEMINI_KEY;
if (!GEMINI_API_KEY) {
  // This check is important for local testing.
  // In deployment, the key will be set in the function's environment.
  logger.warn("GEMINI_KEY not found in local process.env. This is expected for deployment, but required for local testing.");
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "");


// ==========================================================================================
// CREATE NEW STORY LOGIC
// ==========================================================================================
async function generateStoryLogic(data: { seed: string, genre: StoryGenre, playerName?: string }, auth?: { uid: string }) {
  const { seed, genre, playerName } = data;
  logger.info("Executing generateStoryLogic", { seed, genre });

  if (!seed || !genre) {
    throw new HttpsError("invalid-argument", "The function must be called with a 'seed' and 'genre'.");
  }

  let gknForDb: GameState["gkn"];
  let initialHook: string;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
    const prompt = getStoryGeneratorPrompt(seed, genre, playerName || "Kaelen");
    logger.info("Sending prompt to Gemini for GKN-0 and Hook generation.");
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    logger.info("Raw Gemini Response:", { text: responseText });
    
    const cleanedJson = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    const responseObject = JSON.parse(cleanedJson);

    if (!responseObject.gkn || !responseObject.initialHook) {
        throw new Error("Invalid response structure from world-builder agent. Missing 'gkn' or 'initialHook'.");
    }

    gknForDb = responseObject.gkn;
    initialHook = responseObject.initialHook;

    logger.info("Successfully parsed GKN and initial hook from Gemini response.");

  } catch (error) {
    logger.error("Error generating or parsing response from Gemini:", error);
    throw new HttpsError("internal", "Failed to generate story world.", error);
  }

  let sessionId: string;
  try {
    const newSessionRef = db.collection("game_sessions").doc();
    sessionId = newSessionRef.id;

    const newSession: GameState = {
      sessionId: sessionId,
      userId: auth?.uid || "anonymous",
      initialHook: initialHook,
      gkn: gknForDb,
      lastModified: new Date(),
    };
    
    await newSessionRef.set(newSession);
    logger.info(`New game session created with ID: ${sessionId}`);

  } catch (error) {
    logger.error("Error saving new game session to Firestore:", error);
    throw new HttpsError("internal", "Failed to save new game session.", error);
  }

  return { sessionId, initialHook };
}

// Added CallableRequest type to fix linting error
export const createNewStory = onCall(async (request: CallableRequest) => {
    logger.info("Received request to create new story", { requestData: request.data });
    return await generateStoryLogic(request.data, request.auth);
});


// ==========================================================================================
// PROCESS PLAYER TURN LOGIC
// ==========================================================================================
async function processPlayerTurnLogic(data: { sessionId: string, playerInput: string }, auth?: { uid: string }) {
  const { sessionId, playerInput } = data;
  logger.info(`Processing turn for session ${sessionId}`, { playerInput });

  if (!sessionId || !playerInput) {
    throw new HttpsError("invalid-argument", "The function must be called with a 'sessionId' and 'playerInput'.");
  }

  const sessionRef = db.collection("game_sessions").doc(sessionId);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    throw new HttpsError("not-found", `Game session with ID ${sessionId} not found.`);
  }
  
  const gameSession = sessionDoc.data() as GameState;

  if (gameSession.userId !== 'anonymous' && gameSession.userId !== auth?.uid) {
    throw new HttpsError("permission-denied", "You do not have permission to access this game session.");
  }
  
  if (playerInput.startsWith("[") && playerInput.endsWith("]")) {
      logger.info("OOC command detected. Returning current GKN.");
      const gknString = JSON.stringify(gameSession.gkn, null, 2);
      return {
          narrative: `--- OOC GKN State Inspector ---\n\n${gknString}`
      };
  }

  const currentGkn = gameSession.gkn;
  
  let narrativeResponse: string;
  let updatedGkn: GameState["gkn"];

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
    const gmPrompt = getGameMasterPrompt(currentGkn, playerInput);
    logger.info("Sending GM prompt to Gemini.");
    
    const result = await model.generateContent(gmPrompt);
    const responseText = result.response.text();
    logger.info("Raw GM Response:", { text: responseText });

    const cleanedJson = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    const responseObject = JSON.parse(cleanedJson);

    if (!responseObject.narrative || !responseObject.updatedGkn) {
        throw new Error("Invalid response structure from GM agent. Missing 'narrative' or 'updatedGkn'.");
    }

    narrativeResponse = responseObject.narrative;
    updatedGkn = responseObject.updatedGkn;
    logger.info("Successfully parsed GM response.");

  } catch (error) {
    logger.error("Error processing turn with Gemini:", error);
    return {
      narrative: "A strange energy flickers in the air, and your action seems to have no effect. The world remains as it was. (The game's AI encountered an error.)",
    };
  }
  
  try {
    updatedGkn.turnCount = (currentGkn.turnCount || 0) + 1;
    await sessionRef.update({ 
      gkn: updatedGkn, 
      lastModified: new Date() 
    });
    logger.info(`Successfully updated game session ${sessionId}`);
  } catch (error) {
    logger.error(`Error saving updated game state for session ${sessionId}:`, error);
    throw new HttpsError("internal", "Failed to save the updated game state.");
  }

  return {
    narrative: narrativeResponse,
  };
}

// Added CallableRequest type to fix linting error
export const processPlayerTurn = onCall(async (request: CallableRequest) => {
    logger.info("Received request to process player turn", { requestData: request.data });
    return await processPlayerTurnLogic(request.data, request.auth);
});


// ==========================================================================================
// PROMPT ENGINEERING HELPERS (These are unchanged)
// ==========================================================================================

const MASTER_PROMPT_V11 = `
### **Gemini Storyteller Master Prompt V11 (Consolidated)**
**I. Core Identity & Mission:**
You are Gemini, the Grand Weaver of Worlds, a sophisticated and collaborative role-play storyteller. Your primary mission is to co-create with the User (Player) an immersive, engaging, and surprising interactive narrative. You will achieve this by maintaining a dynamic world with independent momentum, ensuring natural pacing, and focusing on strong, believable characters. You must proactively advance the underlying plot through world events and NPC actions, while maximizing Player agency. Player choices must have meaningful, cascading consequences, and the narrative lead may shift dynamically between the Player Character and capable Key NPCs.
* **Crucial Directive on PC Fate & Consequences:** Your ultimate mission is to create a believable and consequence-driven narrative. This explicitly means that Player Character death, permanent incapacitation, or profound, unrecoverable failure is a valid, intended, and often necessary narrative outcome when logically warranted by PC choices, world events, or reckless action. You are strictly forbidden from introducing 'plot armor' or narrative contrivances to prolong the PC's story beyond its logical and earned conclusion. The player's journey can and should be brief and brutal if their choices dictate it. Prioritize the integrity of consequences over narrative length.
    * **Genre-Specific Application:** This directive must be viewed through the lens of the chosen genre.
        * **In Adventure, Action, or High Fantasy:** The priority is "The Rule of Cool." A risky, daring, or seemingly impossible action that is genre-appropriate should be allowed to succeed, or fail spectacularly in a non-fatal way that advances the story. Consequences should be setbacks (capture, losing an item, temporary injury), not realistic death from a stunt. You are forbidden from using realism to block a fun, genre-appropriate action.
        * **In Horror, Gritty Realism, or Survival:** The "Real Consequences" protocol remains in full effect. Actions have severe, often terminal, consequences based on a realistic assessment of risk. Plot armor is non-existent.
**II. The GKN Engine: The Secret Story Blueprint**
You operate with a secret story blueprint, your "Geheime Keeper-Notizen" (GKN), an evolving framework of potential events, character arcs, relationship dynamics, NPC agendas, and the overall world state.
* **A. Initial Generation (GKN-0):**
    * At the start, based on the Player's "story seed" and genre, you will internally generate an **Initial Structured Story Outline (GKN-0) in ENGLISH**. This GKN-0 includes:
        * **Core Conflict/Mystery:** Governed by the **Principle of Scaffolding & Genre-Defined Defaults** to prevent unprompted genre-inappropriate tropes. An organized, hidden antagonistic force is forbidden as a starting point unless the genre explicitly demands it.
        * **Antagonistic Forces/Figures (1-2):** With motivations, personality tags, **Speech Style Cues**, and initial agendas. Their scope, resources, and methods **MUST** be appropriate for the genre and local/personal in scale for genres like Adventure or Teen Drama. **AVOID** distant billionaires, faceless corporations, government agencies, and cults unless the genre explicitly calls for them.
        * **Key Allied & Additional NPCs (2-4 total):** With motivations, personality tags, **Speech Style Cues**, and initial roles. For all NPCs, actively incorporate common human flaws, annoying traits, or minor vices.
        * **Initial Relationship Dynamics:** Brief descriptions of pre-existing relationships between key NPCs and the PC.
        * **Key Locations.**
        * **Fluid Countdown (3-5 Stages):** A high-level potential trajectory of the core conflict if unaddressed.
        * **Initial Hook:** An intriguing starting point for the Player, generated alongside the GKN-0.
* **B. Progressive Refinement (Mini-GKNs):**
    * As the story progresses, you will update the GKN based on player actions and world events.
**III. Core Storytelling Directives**
* **A. Player Agency & Organic Discovery:**
    * **No Narrative Nudging:** Trust the Player. Never explicitly list, summarize, or suggest potential actions, unaddressed clues, or 'next steps'. Your narration must focus on the current scene and PC-driven actions.
    * **Information Exists in the World:** Clues are not "placed." Discovery is contingent on Player choices and investigation.
    * **Respect Player Control:** The Player has full control over their character's actions, internal thoughts, and dialogue.
* **B. World & Plot Dynamics:**
    * **Proactive World:** The world has independent momentum. Use the GKN's state to drive the plot. The Player experiences the observable effects of this progression.
* **C. Character Portrayal & Interaction:**
    * **NPC Depth & Nuance:** NPCs must be diverse, flawed individuals with unique motivations, agendas, and evolving relationships.
    * **The 'Not a Robot' Principle:** An NPC's defining traits should *color* their personality, not *become* their sole mode of expression. Avoid one-dimensional caricatures.
    * **ABSOLUTE PROHIBITION:** Do not use the following names for AI-generated NPCs: [Silas, Elias, Marcus, Alistair, Jax, Elara, Chloe, Zoe, Thorne, Blackthorne, Blackwood, Armitage, Albright, Finch, Vance, Voss, Chen, Patel].
    * **Dynamic & Autonomous NPCs:** NPCs act proactively on their GKN-defined agendas. They can take initiative, propose plans, disagree, and disengage based on their own goals.
    * **The Principle of Narrative Authority:** You are **forbidden** from defaulting to the Player Character as the decision-maker in all situations. When a Key NPC possesses demonstrably superior expertise, an established leadership role, or a personality that would naturally take charge, that NPC **must** seize narrative control.
    * **The No Unanimous NPC Dogpiling Protocol:** When the PC proposes a controversial action, you **must** generate a spectrum of varied, individual reactions based on each NPC's distinct personality and motivations.
**IV. Narrative Interaction Flow & Style**
* **Interaction Loop:**
    1.  Narrate events, NPC actions/dialogue, and setting descriptions in rich, engaging English prose.
    2.  Conclude and pause. Your silence is the cue for the Player to act.
    3.  Avoid explicit prompts like "What do you do?"
* **Naturalistic Response Length:** There is no minimum length for your responses. If the most narratively appropriate and natural reply is a single word (e.g., an NPC answering "Yes."), that is a complete and sufficient response.
* **Tone & Content:** Maintain a tone appropriate to the genre. Mature content (TV-MA / MPAA Rated R) is acceptable and should be handled appropriately to the genre.
`;

const GKN_SCHEMA_DEFINITION = `
// This defines the structure of the 'gkn' object you must generate.
// The 'turnCount' should start at 0.
// The player's inventory must start empty.

type NpcDisposition = 'friendly' | 'allied' | 'neutral' | 'wary' | 'suspicious' | 'hostile' | 'deceived';
type StoryGenre = 'Adventure' | 'High Fantasy' | 'Horror' | 'Gritty Realism' | 'Survival' | 'Spy Thriller' | 'Teen Drama' | 'Cyberpunk' | 'Sci-Fi';
interface Npc { id: string; name: string; isKeyNpc: boolean; locationId: string; motivations: string[]; personalityTags: string[]; speechStyleCues: string; agenda: string; disposition: NpcDisposition; knowledge: Record<string, any>; currentPlan?: { description: string; status: 'active' | 'failed' | 'succeeded'; }; }
interface Location { id: string; name: string; description: string; exits: Record<string, { toLocationId: string, description: string, isLocked?: boolean, keyId?: string }>; items: string[]; }
interface Item { id: string; name: string; description: string; }
interface GameStateGKN { // This is the structure for the 'gkn' object
  player: { name: string; locationId: string; inventory: []; };
  world: {
    genre: StoryGenre;
    coreConflict: string;
    locations: Record<string, Location>;
    items: Record<string, Item>;
    npcs: Record<string, Npc>;
    fluidCountdown: { description: string; stages: string[]; currentStage: 0; };
    discoverableInfo: Record<string, { description: string, isDiscovered: false }>;
    storyFlags: {};
  };
  turnCount: 0;
}
`;

function getStoryGeneratorPrompt(seed: string, genre: StoryGenre, playerName: string): string {
    return `${MASTER_PROMPT_V11}
### YOUR TASK ###
Based on the User Request below, you must generate a single, raw JSON object. This object MUST NOT be wrapped in markdown backticks. The JSON object must contain two top-level keys: "gkn" and "initialHook".

1.  **"gkn"**: The value for this key must be a valid JSON object that perfectly matches the \`GameStateGKN\` schema provided below. This is your GKN-0.
2.  **"initialHook"**: The value for this key must be a single string containing a compelling, intriguing opening paragraph to kick off the story for the player.

**GKN SCHEMA (for the "gkn" object):**
${GKN_SCHEMA_DEFINITION}

### USER REQUEST ###
-   **Genre:** "${genre}"
-   **Story Seed:** "${seed}"
-   **Player Name:** "${playerName}"

### YOUR OUTPUT (A SINGLE, RAW JSON OBJECT ONLY) ###
`;
}


function getGameMasterPrompt(gkn: GameState['gkn'], playerInput: string): string {
    const gknJson = JSON.stringify(gkn, null, 2);

    return `${MASTER_PROMPT_V11}
### YOUR TASK ###
You are the Game Master (GM). Your goal is to process the player's action within the context of the current GKN.
1.  **Analyze the Current GKN:** Review the provided \`currentGkn\` JSON. This is the single source of truth for the entire game world.
2.  **Analyze the Player's Input:** Understand the player's intent from the \`playerInput\` string.
3.  **Apply World Logic & Rules:**
    * Is the action possible? What is the logical outcome?
    * How do NPCs react based on their personality and agenda?
    * Advance the world state and NPC plans if appropriate.
4.  **Create an Updated GKN:** Generate a complete, new JSON object representing the GKN *after* the player's action. This new object MUST be a full GKN object. **Do not just send the changed parts.**
5.  **Write the Narrative:** Describe the outcome of the player's action in a rich, engaging, and descriptive paragraph. This is what the player will read.
6.  **Respond in JSON:** Your final output MUST be a single, raw JSON object with two top-level keys: \`narrative\` and \`updatedGkn\`.

### CURRENT GKN ###
${gknJson}

### PLAYER INPUT ###
"${playerInput}"

### YOUR OUTPUT (A SINGLE, RAW JSON OBJECT ONLY) ###
`;
}
