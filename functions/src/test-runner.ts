import * as dotenv from 'dotenv';
dotenv.config();

// We now import our clean, testable logic function
import { generateStoryLogic } from "./index";
import { HttpsError } from "firebase-functions/v2/https";

async function runTest() {
  console.log("--- Starting Local Test Run ---");

  // Mock the data and auth objects that our logic function expects
  const mockData = {
    seed: "A story about a lone botanist on a newly discovered planet with strange, sentient flora.",
    genre: "Sci-Fi" as const, // Using 'as const' helps TypeScript know the exact string
    playerName: "Dr. Aris",
  };
  const mockAuth = {
    uid: "local-test-user-01",
  };

  try {
    // Call the logic function directly. No more wrapper, no more 'as any'!
    console.log("Calling generateStoryLogic function...");
    const result = await generateStoryLogic(mockData, mockAuth);

    // This will now work perfectly, as 'result' is correctly typed.
    console.log("\n--- Function Succeeded! ---");
    console.log("Session ID:", result.sessionId);
    console.log("Initial Hook:", result.initialHook);
    console.log("\nCheck your LIVE Firestore database for the new document.");

  } catch (error) {
    console.error("\n--- Function Failed! ---");
    if (error instanceof HttpsError) {
        console.error("Error Code:", error.code);
        console.error("Error Message:", error.message);
        console.error("Details:", error.details);
    } else {
        console.error("An unexpected error occurred:", error);
    }
  }
}

runTest();