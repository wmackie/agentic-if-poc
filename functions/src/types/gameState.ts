// File: /src/types/gameState.ts

export type NpcDisposition = 'friendly' | 'allied' | 'neutral' | 'wary' | 'suspicious' | 'hostile' | 'deceived';

export interface Npc {
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

export type StoryGenre = 'Adventure' | 'High Fantasy' | 'Horror' | 'Gritty Realism' | 'Survival' | 'Spy Thriller' | 'Teen Drama' | 'Cyberpunk' | 'Sci-Fi';
export interface Location {
    id: string;
    name: string;
    description: string;
    exits: Record<string, { toLocationId: string, description: string, isLocked?: boolean, keyId?: string }>;
    items: string[];
}

export interface Item {
  id: string;
  name: string;
  description: string;
}

/**
 * Represents the entire session document stored in Firestore.
 * The 'gkn' is nested within this structure.
 */
export interface GameState {
  sessionId: string;
  userId: string;
  initialHook: string;
  lastModified: Date;
  
  gkn: {
    player: {
      name: string;
      locationId: string;
      inventory: string[]; // Array of Item IDs.
    };
    world: {
      genre: StoryGenre;
      coreConflict: string;
      locations: Record<string, Location>;
      items: Record<string, Item>; // A master list of all possible items.
      npcs: Record<string, Npc>;
      fluidCountdown: {
        description: string;
        stages: string[];
        currentStage: number;
      };
      discoverableInfo: Record<string, { description: string, isDiscovered: boolean }>;
      storyFlags: Record<string, any>;
    };
    turnCount: number;
  }
}