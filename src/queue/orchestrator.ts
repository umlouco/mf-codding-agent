import { OrchestratorPipeline } from './orchestratorPipeline';
export type { OrchestratorStatus,RunMode } from './orchestratorState';

/** Queue lifecycle, supervisor graph, coder and tester lanes share one fenced runtime. */
export class Orchestrator extends OrchestratorPipeline {}
