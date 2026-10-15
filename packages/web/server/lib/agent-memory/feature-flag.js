// Memory is a supported capability. The persisted agentMemoryToolEnabled
// setting remains off by default and gates every agent read and write.
export const isAgentMemoryFeatureAvailable = () => true;
