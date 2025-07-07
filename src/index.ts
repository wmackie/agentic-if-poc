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