import { ApplicationPrivateError } from '../../application/azure-activation/application-private-errors.js';

export class ApplicationPrivateResourceReadbackError extends ApplicationPrivateError {
  constructor(code: string, readonly receipt: {
    address: string; requestedResourceId: string; readbackRequestId: string; status: number;
  }) { super(code); }
}
