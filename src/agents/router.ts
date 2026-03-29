import { Agent, Task } from './baseAgent';
import { SoicoAgent } from './soico/soicoAgent';

const agents: Record<string, Agent> = {
  soico: new SoicoAgent(),
};

export function getAgent(agentName: string): Agent | null {
  return agents[agentName] || null;
}

export function registerAgent(name: string, agent: Agent): void {
  agents[name] = agent;
}

export function listAgents(): string[] {
  return Object.keys(agents);
}
