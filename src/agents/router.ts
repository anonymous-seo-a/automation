import { Agent, Task } from './baseAgent';
import { SoicoAgent } from './soico/soicoAgent';
import { DevAgent } from './dev/devAgent';

const agents: Record<string, Agent> = {
  soico: new SoicoAgent(),
  dev: new DevAgent(),
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
