// File: src/types/gameState.ts

export type NpcDisposition = 'friendly' | 'allied' | 'neutral' | 'wary' | 'suspicious' | 'hostile' | 'deceived';

export interface Npc {
  id: string; 
  name: string;
  isKeyNpc: boolean;
  locationId: string; // Added this! We need to know where NPCs are.
  
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
    exits: Record<string, { toLocationId: string, description: string, isLocked?: boolean, keyId?: string }>; // More detailed exits
    items: string[];
    // We can derive NPCs in a location by querying the Npc objects themselves.
}

export interface Item {
  id: string;
  name: string;
  description: string;
}

export interface GameState {
  sessionId: string;
  userId: string;
  
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
  
  lastModified: Date;
  turnCount: number;
}