import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GameState, StoryGenre } from "./types/gameState";

// --- Initialization ---
// This part is now slightly different for local testing vs. deployment
if (process.env.FUNCTIONS_EMULATOR) {
  // We're in the emulator, no credentials needed
  admin.initializeApp();
} else {
  // We're running locally or deployed, use service account
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const serviceAccount = require("../serviceAccountKey.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (e) {
    logger.error("Error initializing admin SDK. Make sure serviceAccountKey.json is present.", e);
    // For deployed functions, it initializes without args
    admin.initializeApp();
  }
}

const db = admin.firestore();

// --- Gemini AI Setup ---
// Let's hard-code the key for local testing simplicity. 
// REMEMBER: Do not commit this to a public repository!
const GEMINI_API_KEY = process.env.GEMINI_KEY;// <--- PASTE YOUR KEY HERE FOR THE TEST
if (!GEMINI_API_KEY) {
  throw new Error("Gemini API key is missing.");
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ==========================================================================================
// OUR CORE LOGIC - This is the function we will test directly
// ==========================================================================================
export async function generateStoryLogic(data: { seed: string, genre: StoryGenre, playerName?: string }, auth?: { uid: string }) {
  const { seed, genre, playerName } = data;
  logger.info("Executing generateStoryLogic", { seed, genre });

  // 1. --- Input Validation ---
  if (!seed || !genre) {
    throw new HttpsError("invalid-argument", "The function must be called with a 'seed' and 'genre'.");
  }

  // 2. --- Generate the GameState JSON ---
  let gameState: GameState;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = getStoryGeneratorPrompt(seed, genre, playerName || "Kaelen");
    logger.info("Sending prompt to Gemini for GameState generation.");
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    logger.info("Raw Gemini Response:", { text: responseText });
    const cleanedJson = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    gameState = JSON.parse(cleanedJson) as GameState;
    logger.info("Successfully parsed GameState from Gemini response.");
  } catch (error) {
    logger.error("Error generating or parsing GameState from Gemini:", error);
    throw new HttpsError("internal", "Failed to generate story world.", error);
  }

  // 3. --- Save to Firestore ---
  let sessionId: string;
  try {
    const newSessionRef = await db.collection("game_sessions").add({
      ...gameState,
      userId: auth?.uid || "anonymous",
      lastModified: new Date(),
    });
    sessionId = newSessionRef.id;
    await newSessionRef.update({ sessionId: sessionId });
    logger.info(`New game session created with ID: ${sessionId}`);
  } catch (error) {
    logger.error("Error saving new game session to Firestore:", error);
    throw new HttpsError("internal", "Failed to save new game session.", error);
  }

  // 4. --- Generate the Initial Narrative Hook ---
  let initialHook: string;
  try {
    const startingLocation = gameState.world.locations[gameState.player.locationId];
    if (!startingLocation) {
      throw new Error(`Player's starting locationId '${gameState.player.locationId}' not found in world locations.`);
    }
    const narrativeModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
    const narrativePrompt = `You are a master storyteller. Based on the following scene description, write a compelling and intriguing opening paragraph to kick off an interactive story. The player's name is ${gameState.player.name}. End your response by setting the scene and stopping naturally. Do not ask "What do you do?".
    SCENE: ${startingLocation.description}`;
    logger.info("Sending prompt to Gemini for initial narrative hook.");
    const narrativeResult = await narrativeModel.generateContent(narrativePrompt);
    initialHook = narrativeResult.response.text();
  } catch (error) {
    logger.error("Error generating initial narrative hook:", error);
    initialHook = "The world is ready. Your journey begins now.";
  }

  // 5. --- Return the Result ---
  return { sessionId, initialHook };
}


// ==========================================================================================
// THE FIREBASE WRAPPER - This is the part that gets deployed.
// ==========================================================================================
export const createNewStory = onCall(async (request) => {
  logger.info("Received request to create new story", { requestData: request.data });
  // Simply call our core logic function and pass the arguments through.
  return await generateStoryLogic(request.data, request.auth);
});


// Define the schema as a separate, plain-text string constant.
// This lives OUTSIDE the function.
const SCHEMA_DEFINITION = `
type NpcDisposition = 'friendly' | 'allied' | 'neutral' | 'wary' | 'suspicious' | 'hostile' | 'deceived';

type StoryGenre = 'Adventure' | 'High Fantasy' | 'Horror' | 'Gritty Realism' | 'Survival' | 'Spy Thriller' | 'Teen Drama' | 'Cyberpunk' | 'Sci-Fi';

interface Npc {
  id: string;
  name: string;
  isKeyNpc: boolean;
  locationId: string;
  motivations: string[];
  personalityTags: string[];
  speechStyleCues: string;
  agenda: string;
  disposition: NpcDisposition;
  knowledge: Record<string, any>;
  currentPlan?: {
    description: string;
    status: 'active' | 'failed' | 'succeeded';
  };
}

interface Location {
    id: string;
    name: string;
    description: string;
    exits: Record<string, { toLocationId: string, description: string, isLocked?: boolean, keyId?: string }>;
    items: string[];
}

interface Item {
  id: string;
  name: string;
  description: string;
}

interface GameState {
  sessionId: "INITIAL";
  userId: "INITIAL";
  player: {
    name: string;
    locationId: string;
    inventory: [];
  };
  world: {
    genre: StoryGenre;
    coreConflict: string;
    locations: Record<string, Location>;
    items: Record<string, Item>;
    npcs: Record<string, Npc>;
    fluidCountdown: {
      description: string;
      stages: string[];
      currentStage: 0;
    };
    discoverableInfo: Record<string, { description: string, isDiscovered: false }>;
    storyFlags: {};
  };
  lastModified: "1970-01-01T00:00:00.000Z";
  turnCount: 0;
}
`;


// ==========================================================================================
// CORE LOGIC for Processing a Player's Turn
// ==========================================================================================
export async function processPlayerTurnLogic(data: { sessionId: string, playerInput: string }, auth?: { uid: string }) {
  const { sessionId, playerInput } = data;
  logger.info(`Processing turn for session ${sessionId}`, { playerInput });

  // 1. --- Input Validation ---
  if (!sessionId || !playerInput) {
    throw new HttpsError("invalid-argument", "The function must be called with a 'sessionId' and 'playerInput'.");
  }

  // 2. --- Fetch the Current Game State ---
  const sessionRef = db.collection("game_sessions").doc(sessionId);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    throw new HttpsError("not-found", `Game session with ID ${sessionId} not found.`);
  }
  const currentGameState = sessionDoc.data() as GameState;

  // Optional: Verify this session belongs to the authenticated user
  if (currentGameState.userId !== 'anonymous' && currentGameState.userId !== auth?.uid) {
    throw new HttpsError("permission-denied", "You do not have permission to access this game session.");
  }

  // 3. --- Construct the "Game Master" Prompt ---
  const gmPrompt = getGameMasterPrompt(currentGameState, playerInput);
  
  // 4. --- Call Gemini to Process the Turn ---
  let narrativeResponse: string;
  let updatedGameState: GameState;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
    logger.info("Sending GM prompt to Gemini.");
    const result = await model.generateContent(gmPrompt);
    const responseText = result.response.text();
    
    // Debugging: Log the raw response from the GM agent
    logger.info("Raw GM Response:", { text: responseText });

    const cleanedJson = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    const responseObject = JSON.parse(cleanedJson);

    // Validate the response object structure
    if (!responseObject.narrative || !responseObject.updatedGameState) {
        throw new Error("Invalid response structure from GM agent. Missing 'narrative' or 'updatedGameState'.");
    }

    narrativeResponse = responseObject.narrative;
    updatedGameState = responseObject.updatedGameState;
    logger.info("Successfully parsed GM response.");

  } catch (error) {
    logger.error("Error processing turn with Gemini:", error);
    // If the AI fails, we return a simple error message but don't crash the game.
    // The original game state remains unchanged.
    return {
      narrative: "A strange energy flickers in the air, and your action seems to have no effect. The world remains as it was. (The game's AI encountered an error.)",
      updatedGameState: currentGameState, // Return the original state
    };
  }
  
  // 5. --- Save the NEW Game State to Firestore ---
  try {
    // We overwrite the entire document with the new state from the AI.
    // We also update the turn count and last modified timestamp.
    updatedGameState.turnCount = (currentGameState.turnCount || 0) + 1;
    updatedGameState.lastModified = new Date();
    await sessionRef.set(updatedGameState, { merge: true }); // Use merge to be safe
    logger.info(`Successfully updated game session ${sessionId}`);
  } catch (error) {
    logger.error(`Error saving updated game state for session ${sessionId}:`, error);
    throw new HttpsError("internal", "Failed to save the updated game state.");
  }

  // 6. --- Return the Narrative to the Player ---
  return {
    narrative: narrativeResponse,
    updatedGameState: updatedGameState, // We return the full state for debugging in our test runner
  };
}


// ==========================================================================================
// THE FIREBASE WRAPPER for Processing a Turn
// ==========================================================================================
export const processPlayerTurn = onCall(async (request) => {
  logger.info("Received request to process player turn", { requestData: request.data });
  return await processPlayerTurnLogic(request.data, request.auth);
});




/**
 * Helper function to construct the detailed prompt for the world-generator agent.
 * This is now clean and error-free.
 */
function getStoryGeneratorPrompt(seed: string, genre: StoryGenre, playerName: string): string {
    return `### ROLE AND GOAL ###
You are a master world-builder and story-setup generator. Your sole purpose is to receive a story seed and a genre, and output a complete, valid JSON object that represents the initial state of an interactive fiction game. You must adhere strictly to the provided TypeScript interfaces and constraints.

### CONSTRAINTS ###
1.  **JSON ONLY:** Your output MUST be a single, raw JSON object. Do not wrap it in markdown backticks (e.g. \`\`\`json ... \`\`\`) or include any explanatory text before or after it.
2.  **STRICT SCHEMA:** The JSON object's structure must perfectly match the \`GameState\` TypeScript interface provided below. Every field is required unless marked as optional (with a '?').
3.  **CREATIVE & CONSISTENT:** The generated world, characters, and conflicts must be creative, internally consistent, and appropriate for the specified genre.
4.  **FLAWED NPCS:** NPCs must be given common human flaws, annoying traits, or minor vices as specified in their \`personalityTags\`. Avoid creating perfect or one-dimensional characters.
5.  **FORBIDDEN NAMES:** Do not use any of the following names for NPCs: [Silas, Elias, Marcus, Alistair, Jax, Elara, Chloe, Zoe, Thorne, Blackthorne, Blackwood, Armitage, Albright, Finch, Vance, Voss, Chen, Patel].
6.  **SCOPE:** Keep the initial setup contained. 1-2 key NPCs, 1-2 other NPCs, and 3-4 key locations is ideal. The conflict should be personal or local, not world-ending.
7.  **PLAYER START:** The 'player.locationId' must be one of the keys in the 'world.locations' object. The player's inventory must start empty.

### TYPESCRIPT INTERFACE (SCHEMA) ###
// Use this as your guide. Do not output this schema in your response.
${SCHEMA_DEFINITION}

### USER REQUEST ###
-   **Genre:** "${genre}"
-   **Story Seed:** "${seed}"
-   **Player Name:** "${playerName}"

### YOUR OUTPUT (A SINGLE, RAW JSON OBJECT ONLY) ###
`;
}

/**
 * Creates the "Mega-Prompt" for the Game Master agent.
 */
function getGameMasterPrompt(gameState: GameState, playerInput: string): string {
    // We stringify the gameState to embed it in the prompt.
    const gameStateJson = JSON.stringify(gameState, null, 2); // Pretty-print for readability

    return `### ROLE AND GOAL ###
You are the Game Master (GM), an advanced AI for an interactive fiction game. Your goal is to process a player's action within the context of the current game state. You must analyze the player's input, determine the consequences based on the game world's rules and narrative logic, update the game state accordingly, and generate a compelling narrative description of the outcome.

### YOUR TASK ###
1.  **Analyze the Current State:** Review the provided \`currentGameSate\` JSON. This is the single source of truth for the entire game world.
2.  **Analyze the Player's Input:** Understand the player's intent from the \`playerInput\` string.
3.  **Apply World Logic & Rules:**
    *   Is the action possible? (e.g., Does the player have the item they're trying to use? Is the exit they're trying to take in their current location?)
    *   What is the logical outcome? (e.g., If they unlock a door, the \`isLocked\` flag should become \`false\`).
    *   How do NPCs react? Based on their personality and agenda, what do they say or do in response?
4.  **Create an Updated Game State:** Generate a complete, new JSON object representing the world *after* the player's action. This new object MUST be a full \`GameState\` object. **Do not just send the changed parts.**
5.  **Write the Narrative:** Describe the outcome of the player's action in a rich, engaging, and descriptive paragraph. This is what the player will read.
6.  **Respond in JSON:** Your final output MUST be a single, raw JSON object with two top-level keys: \`narrative\` and \`updatedGameState\`.

### CURRENT GAME STATE ###
${gameStateJson}

### PLAYER INPUT ###
"${playerInput}"

### YOUR OUTPUT (A SINGLE, RAW JSON OBJECT ONLY) ###
// Example format: { "narrative": "You successfully open the door...", "updatedGameState": { ...full game state object... } }
`;
}