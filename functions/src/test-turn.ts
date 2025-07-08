import * as dotenv from 'dotenv';
dotenv.config();

// Import both of our core logic functions
import { generateStoryLogic, processPlayerTurnLogic } from "./index";
import { HttpsError } from "firebase-functions/v2/https";

// Main test function
async function runTurnTest() {
  console.log("--- Starting Turn Test Run ---");
  let sessionId: string;

  // === STEP 1: Create a new story to test against ===
  try {
    console.log("Creating a new story for the test...");
    const storyData = {
      seed: "A dusty old library with a secret to hide.",
      genre: "Adventure" as const,
      playerName: "Alex",
    };
    const storyResult = await generateStoryLogic(storyData, { uid: "turn-test-user" });
    sessionId = storyResult.sessionId;
    console.log(`Story created with Session ID: ${sessionId}`);
    console.log("Initial Hook:", storyResult.initialHook);
  } catch (error) {
    console.error("Failed to create story for test.", error);
    return; // Stop the test if story creation fails
  }

  // === STEP 2: Process the first player turn ===
  if (sessionId) {
    try {
        const turnData = {
            sessionId: sessionId,
            playerInput: "I look around the room, taking note of any interesting books or furniture."
        };
        console.log(`\n--- Processing Turn 1 ---`);
        console.log(`Player Input: "${turnData.playerInput}"`);

        // Corrected: The function now only returns the narrative.
        const turnResult = await processPlayerTurnLogic(turnData, { uid: "turn-test-user" });

        console.log("\n--- Turn Succeeded! ---");
        console.log("\nNARRATIVE RESPONSE:");
        console.log(turnResult.narrative);

        // This line caused the error and has been removed, as updatedGameState is no longer returned.

    } catch (error) {
        console.error("\n--- Turn Processing Failed! ---");
        if (error instanceof HttpsError) {
            console.error("Error Code:", error.code);
            console.error("Error Message:", error.message);
        } else {
            console.error("An unexpected error occurred:", error);
        }
    }
  }
}

// Execute the turn test
runTurnTest();