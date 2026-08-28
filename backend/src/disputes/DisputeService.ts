import { randomUUID } from 'node:crypto';
import { auditService } from '../services/auditService.js';
import { ArbitratorService } from './ArbitratorService.js';

export type DisputeStatus = 'opened' | 'evidence_gathering' | 'under_review' | 'resolved' | 'appealed' | 'closed';

export type ResolutionType = 'refund' | 'release' | 'split';

export interface EvidenceItem {
  id: string;
  type: 'document' | 'image' | 'message' | 'other';
  title: string;
  description?: string;
  url: string;
  uploadedBy: string;
  uploadedAt: number;
}

export interface DisputeRecord {
  id: string;
  projectId: string;
  escrowId: string;
  raisedBy: string;
  raisedAgainst: string;
  reason: string;
  status: DisputeStatus;
  evidence: EvidenceItem[];
  arbitratorId?: string;
  resolution?: {
    type: ResolutionType;
    description: string;
    approvedBy: string;
    approvedAt: number;
    refundAmount?: string;
    releaseAmount?: string;
    splitRatio?: { partyA: number; partyB: number };
  };
  appealTarget?: string;
  appealDeadline?: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  auditTimeline: Array<{ action: string; by: string; at: number; detail?: string }>;
}

export type VoteDecision = 'favor_client' | 'favor_freelancer' | 'split';

export interface DisputeVote {
  id: string;
  disputeId: string;
  arbitratorId: string;
  decision: VoteDecision;
  weight: number;
  reasoning: string;
  votedAt: string;
  votePower: number;
}

export interface VotingRound {
  disputeId: string;
  votes: DisputeVote[];
  status: 'open' | 'closed' | 'tallied';
  deadline: string;
  quorumRequired: number;
  result: { decision: string; totalWeight: number; consensusReached: boolean } | null;
}

export class DisputeService {
  private disputes = new Map<string, DisputeRecord>();
  private votingRounds = new Map<string, VotingRound>();
  private arbitratorService: ArbitratorService;

  constructor() {
    this.arbitratorService = new ArbitratorService();
  }

  async createDispute(params: {
    projectId: string;
    escrowId: string;
    raisedBy: string;
    raisedAgainst: string;
    reason: string;
  }): Promise<DisputeRecord> {
    const dispute: DisputeRecord = {
      id: randomUUID(),
      status: 'opened',
      evidence: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auditTimeline: [{ action: 'dispute.created', by: params.raisedBy, at: Date.now() }],
      ...params,
    };

    this.disputes.set(dispute.id, dispute);

    const arbitrator = this.arbitratorService.assignArbitrator(dispute.id);
    if (arbitrator) {
      dispute.arbitratorId = arbitrator.id;
      dispute.status = 'under_review';
      dispute.auditTimeline.push({ action: 'arbitrator.assigned', by: 'system', at: Date.now(), detail: arbitrator.id });
      this.disputes.set(dispute.id, dispute);
    }

    await auditService.logAction({ action: 'dispute.created', resource: 'dispute', resourceId: dispute.id, details: { projectId: params.projectId, raisedBy: params.raisedBy, reason: params.reason } });
    return dispute;
  }

  async addEvidence(disputeId: string, evidence: Omit<EvidenceItem, 'id' | 'uploadedAt'>): Promise<DisputeRecord | null> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute || dispute.status === 'closed' || dispute.status === 'resolved') return null;

    const item: EvidenceItem = { ...evidence, id: randomUUID(), uploadedAt: Date.now() };
    dispute.evidence.push(item);
    if (dispute.status === 'opened') dispute.status = 'evidence_gathering';
    dispute.updatedAt = Date.now();
    dispute.auditTimeline.push({ action: 'evidence.added', by: evidence.uploadedBy, at: Date.now(), detail: evidence.title });
    this.disputes.set(disputeId, dispute);
    return dispute;
  }

  async resolveDispute(disputeId: string, resolution: {
    type: ResolutionType;
    description: string;
    approvedBy: string;
    refundAmount?: string;
    releaseAmount?: string;
    splitRatio?: { partyA: number; partyB: number };
  }): Promise<DisputeRecord | null> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute || dispute.status === 'closed') return null;

    dispute.status = 'resolved';
    dispute.resolution = { ...resolution, approvedAt: Date.now() };
    dispute.resolvedAt = Date.now();
    dispute.updatedAt = Date.now();
    dispute.auditTimeline.push({ action: 'dispute.resolved', by: resolution.approvedBy, at: Date.now(), detail: resolution.type });
    this.disputes.set(disputeId, dispute);

    await auditService.logAction({ action: 'dispute.resolved', resource: 'dispute', resourceId: disputeId, details: { type: resolution.type, approvedBy: resolution.approvedBy } });
    return dispute;
  }

  async appealDispute(disputeId: string, appealTarget: string): Promise<DisputeRecord | null> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute || dispute.status !== 'resolved') return null;

    dispute.status = 'appealed';
    dispute.appealTarget = appealTarget;
    dispute.appealDeadline = Date.now() + 14 * 24 * 60 * 60 * 1000;
    dispute.updatedAt = Date.now();
    dispute.auditTimeline.push({ action: 'dispute.appealed', by: 'system', at: Date.now(), detail: `Appealed to ${appealTarget}` });
    this.disputes.set(disputeId, dispute);
    return dispute;
  }

  async closeDispute(disputeId: string, closedBy: string): Promise<DisputeRecord | null> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) return null;

    dispute.status = 'closed';
    dispute.updatedAt = Date.now();
    dispute.auditTimeline.push({ action: 'dispute.closed', by: closedBy, at: Date.now() });
    this.disputes.set(disputeId, dispute);
    return dispute;
  }

  getDispute(disputeId: string): DisputeRecord | undefined {
    return this.disputes.get(disputeId);
  }

  listDisputes(status?: DisputeStatus): DisputeRecord[] {
    const all = Array.from(this.disputes.values());
    return status ? all.filter(d => d.status === status) : all;
  }

  getDisputesByUser(userId: string): DisputeRecord[] {
    return Array.from(this.disputes.values()).filter(d => d.raisedBy === userId || d.raisedAgainst === userId);
  }

  getArbitratorService(): ArbitratorService {
    return this.arbitratorService;
  }

  startVotingRound(disputeId: string, quorumRequired: number, deadlineDays: number = 7): VotingRound {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found`);
    }

    const existing = this.votingRounds.get(disputeId);
    if (existing && existing.status === 'open') {
      throw new Error(`Voting round already open for dispute ${disputeId}`);
    }

    const deadline = new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000).toISOString();

    const round: VotingRound = {
      disputeId,
      votes: [],
      status: 'open',
      deadline,
      quorumRequired,
      result: null,
    };

    this.votingRounds.set(disputeId, round);
    return round;
  }

  castVote(
    disputeId: string,
    arbitratorId: string,
    decision: VoteDecision,
    reasoning: string,
    weight: number,
  ): DisputeVote {
    const round = this.votingRounds.get(disputeId);
    if (!round || round.status !== 'open') {
      throw new Error(`No open voting round for dispute ${disputeId}`);
    }

    if (new Date(round.deadline) < new Date()) {
      round.status = 'closed';
      this.votingRounds.set(disputeId, round);
      throw new Error(`Voting round for dispute ${disputeId} has expired`);
    }

    if (round.votes.some(v => v.arbitratorId === arbitratorId)) {
      throw new Error(`Arbitrator ${arbitratorId} has already voted on dispute ${disputeId}`);
    }

    const dispute = this.disputes.get(disputeId);
    if (!dispute || dispute.arbitratorId !== arbitratorId) {
      const isAssigned = this.arbitratorService.getArbitrator(arbitratorId) !== undefined;
      if (!isAssigned) {
        throw new Error(`Arbitrator ${arbitratorId} is not registered`);
      }
    }

    const votePower = weight * (this.arbitratorService.getArbitrator(arbitratorId)?.rating ?? 1);

    const vote: DisputeVote = {
      id: randomUUID(),
      disputeId,
      arbitratorId,
      decision,
      weight,
      reasoning,
      votedAt: new Date().toISOString(),
      votePower,
    };

    round.votes.push(vote);
    this.votingRounds.set(disputeId, round);
    return vote;
  }

  tallyVotes(disputeId: string): VotingRound {
    const round = this.votingRounds.get(disputeId);
    if (!round) {
      throw new Error(`No voting round found for dispute ${disputeId}`);
    }

    if (round.status === 'tallied') {
      return round;
    }

    round.status = 'closed';

    const totals: Record<VoteDecision, number> = {
      favor_client: 0,
      favor_freelancer: 0,
      split: 0,
    };

    for (const vote of round.votes) {
      totals[vote.decision] += vote.votePower;
    }

    const totalWeight = Object.values(totals).reduce((sum, w) => sum + w, 0);
    const consensusReached = round.votes.length >= round.quorumRequired;

    let decision: string = 'no_consensus';
    if (consensusReached) {
      const maxDecision = (Object.entries(totals) as [VoteDecision, number][]).sort(
        (a, b) => b[1] - a[1],
      )[0];

      const majority = maxDecision[1] / totalWeight;
      decision = majority > 0.5 ? maxDecision[0] : 'split_decision';
    }

    round.result = {
      decision,
      totalWeight,
      consensusReached,
    };

    round.status = 'tallied';
    this.votingRounds.set(disputeId, round);
    return round;
  }

  getVotingRound(disputeId: string): VotingRound | undefined {
    return this.votingRounds.get(disputeId);
  }

  isVotingOpen(disputeId: string): boolean {
    const round = this.votingRounds.get(disputeId);
    if (!round || round.status !== 'open') return false;
    return new Date(round.deadline) >= new Date();
  }
}

export const disputeService = new DisputeService();
