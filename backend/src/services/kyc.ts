import { randomUUID } from 'node:crypto';

export type KycStatus = 'pending' | 'under_review' | 'approved' | 'rejected' | 'expired';

export type DocumentType =
  | 'passport'
  | 'drivers_license'
  | 'national_id'
  | 'utility_bill'
  | 'bank_statement';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface KycDocument {
  id: string;
  userId: string;
  type: DocumentType;
  fileUrl: string;
  uploadedAt: string;
  verified: boolean;
  verifiedAt?: string;
}

export interface KycProfile {
  userId: string;
  status: KycStatus;
  documents: KycDocument[];
  riskScore: number;
  riskLevel: RiskLevel;
  amlCheckPassed: boolean;
  sanctionsCheckPassed: boolean;
  pepCheckPassed: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface RiskAssessment {
  userId: string;
  score: number;
  level: RiskLevel;
  factors: string[];
  assessedAt: string;
}

const HIGH_RISK_COUNTRIES = [
  'AF', 'BI', 'KP', 'IR', 'IQ', 'LY', 'SO', 'SS', 'SY', 'YE',
  'CU', 'VE', 'MM', 'BY', 'RU', 'UA',
];

const now = (): string => new Date().toISOString();

export class KycService {
  private profiles = new Map<string, KycProfile>();

  submitDocument(userId: string, type: DocumentType, fileUrl: string): KycDocument {
    const profile = this.profiles.get(userId);

    const document: KycDocument = {
      id: randomUUID(),
      userId,
      type,
      fileUrl,
      uploadedAt: now(),
      verified: false,
    };

    if (!profile) {
      const newProfile: KycProfile = {
        userId,
        status: 'under_review',
        documents: [document],
        riskScore: 0,
        riskLevel: 'low',
        amlCheckPassed: false,
        sanctionsCheckPassed: false,
        pepCheckPassed: false,
        createdAt: now(),
        updatedAt: now(),
      };
      this.profiles.set(userId, newProfile);
    } else {
      profile.documents.push(document);
      if (profile.status === 'pending') {
        profile.status = 'under_review';
      }
      profile.updatedAt = now();
    }

    return document;
  }

  verifyDocument(documentId: string, approved: boolean): KycDocument | undefined {
    for (const profile of this.profiles.values()) {
      const doc = profile.documents.find(d => d.id === documentId);
      if (doc) {
        doc.verified = approved;
        doc.verifiedAt = now();
        profile.updatedAt = now();
        return doc;
      }
    }
    return undefined;
  }

  assessRisk(userId: string): RiskAssessment {
    const profile = this.profiles.get(userId);
    const factors: string[] = [];
    let score = 0;

    if (!profile) {
      return {
        userId,
        score: 0,
        level: 'low',
        factors: ['No KYC profile found'],
        assessedAt: now(),
      };
    }

    const verifiedCount = profile.documents.filter(d => d.verified).length;
    if (verifiedCount === 0) {
      score += 15;
      factors.push('No verified identity documents');
    } else if (verifiedCount === 1) {
      score += 5;
      factors.push('Only one verified identity document');
    }

    if (profile.documents.length === 0) {
      score += 20;
      factors.push('No documents submitted');
    }

    const unverifiedDocs = profile.documents.filter(d => !d.verified);
    if (unverifiedDocs.length > 0) {
      score += unverifiedDocs.length * 3;
      factors.push(`${unverifiedDocs.length} document(s) pending verification`);
    }

    if (profile.amlCheckPassed) {
      score += 5;
      factors.push('AML check passed');
    } else {
      score += 15;
      factors.push('AML check not yet completed');
    }

    if (!profile.sanctionsCheckPassed) {
      score += 10;
      factors.push('Sanctions screening not yet completed');
    }

    if (!profile.pepCheckPassed) {
      score += 5;
      factors.push('PEP screening not yet completed');
    }

    const level = this.getRiskLevel(score);

    return {
      userId,
      score,
      level,
      factors,
      assessedAt: now(),
    };
  }

  runAmlCheck(userId: string): boolean {
    const profile = this.profiles.get(userId);
    if (!profile) return false;

    profile.amlCheckPassed = true;
    profile.updatedAt = now();
    return true;
  }

  runSanctionsCheck(userId: string): boolean {
    const profile = this.profiles.get(userId);
    if (!profile) return false;

    profile.sanctionsCheckPassed = true;
    profile.updatedAt = now();
    return true;
  }

  runPepCheck(userId: string): boolean {
    const profile = this.profiles.get(userId);
    if (!profile) return false;

    profile.pepCheckPassed = true;
    profile.updatedAt = now();
    return true;
  }

  getProfile(userId: string): KycProfile | undefined {
    return this.profiles.get(userId);
  }

  updateStatus(userId: string, status: KycStatus): KycProfile | undefined {
    const profile = this.profiles.get(userId);
    if (!profile) return undefined;

    profile.status = status;
    profile.updatedAt = now();

    if (status === 'approved') {
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      profile.expiresAt = new Date(Date.now() + oneYear).toISOString();
    }

    return profile;
  }

  isKycComplete(userId: string): boolean {
    const profile = this.profiles.get(userId);
    if (!profile) return false;

    return (
      profile.status === 'approved' &&
      profile.amlCheckPassed &&
      profile.sanctionsCheckPassed &&
      profile.pepCheckPassed
    );
  }

  getRiskLevel(score: number): RiskLevel {
    if (score <= 25) return 'low';
    if (score <= 50) return 'medium';
    if (score <= 75) return 'high';
    return 'critical';
  }
}

export const kycService = new KycService();
