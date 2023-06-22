/*****
 License
 --------------
 Copyright © 2017 Bill & Melinda Gates Foundation
 The Mojaloop files are made available by the Bill & Melinda Gates Foundation under the Apache License, Version 2.0 (the "License") and you may not use these files except in compliance with the License. You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, the Mojaloop files are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

 Contributors
 --------------
 This is the official list (alphabetical ordering) of the Mojaloop project contributors for this file.
 Names of the original copyright holders (individuals or organizations)
 should be listed with a '*' in the first column. People who have
 contributed from an organization can be listed under the organization
 that actually holds the copyright for their contributions (see the
 Gates Foundation organization for an example). Those individuals should have
 their names indented and be marked with a '-'. Email address can be added
 optionally within square brackets <email>.

 * Gates Foundation
 - Name Surname <name.surname@gatesfoundation.com>

 * Crosslake
 - Pedro Sousa Barreto <pedrob@crosslaketech.com>

 * Arg Software
 - José Antunes <jose.antunes@arg.software>
 - Rui Rocha <rui.rocha@arg.software>

 --------------
 ******/

"use strict";
import {createHash, randomUUID} from "crypto";
import {
    AccountsBalancesHighLevelRequestTypes,
    IAccountsBalancesHighLevelRequest,
    IAccountsBalancesHighLevelResponse
} from "@mojaloop/accounts-and-balances-bc-public-types-lib";
import {IAuditClient} from "@mojaloop/auditing-bc-public-types-lib";
import {ILogger} from "@mojaloop/logging-bc-public-types-lib";
import {
    CommandMsg,
    DomainErrorEventMsg,
    DomainEventMsg,
    IDomainMessage,
    IMessageProducer,
    MessageTypes
} from "@mojaloop/platform-shared-lib-messaging-types-lib";
import {PrepareTransferCmd, CommitTransferFulfilCmd, QueryTransferCmd, RejectTransferCmd} from "./commands";
import {
    IAccountsBalancesAdapter, 
    IParticipantsServiceAdapter, 
    ITransfersRepository, 
    ISettlementsServiceAdapter
} from "./interfaces/infrastructure";
import {
    CheckLiquidityAndReserveFailedError,
    HubAccountNotFoundError,
    HubNotFoundError,
    InvalidMessagePayloadError,
    InvalidMessageTypeError,
    NoSuchAccountError,
    NoSuchTransferError,
    PayeeLiquidityAccountNotFoundError,
    PayeeParticipantNotFoundError,
    PayeePositionAccountNotFoundError,
    PayerLiquidityAccountNotFoundError,
    PayerParticipantNotFoundError,
    PayerPositionAccountNotFoundError,
    RequiredParticipantIsNotActive,
    TransferNotFoundError,
    UnableToCancelTransferError,
    UnableToCancelTransferNotAvailableError
} from "./errors";
import {AccountType, ITransfer, ITransferAccounts, ITransferParticipants, TransferState} from "./types";
import {IParticipant, IParticipantAccount} from "@mojaloop/participant-bc-public-types-lib";
import {ICounter, IHistogram, IMetrics} from "@mojaloop/platform-shared-lib-observability-types-lib";
import {
	TransferCommittedFulfiledEvt,
	TransferCommittedFulfiledEvtPayload,
	TransferFulfilCommittedRequestedEvt,
	TransferPreparedEvt,
	TransferPreparedEvtPayload,
	TransferPrepareRequestedEvt,
	TransferRejectRequestedEvt,
	TransferRejectRequestProcessedEvt,
	TransferRejectRequestProcessedEvtPayload,
	TransferQueryReceivedEvt,
	TransferQueryResponseEvt,
	TransferQueryResponseEvtPayload,
	TransferInvalidMessagePayloadEvt,
	TransferInvalidMessageTypeEvt,
	TransfersBCUnknownErrorEvent,
	TransferUnableToGetParticipantsInfoEvt,
	TransferPrepareInvalidPayerCheckFailedEvt,
	TransferPrepareInvalidPayeeCheckFailedEvt,
	TransferUnableToAddEvt,
	TransferUnableToUpdateEvt,
	TransferQueryInvalidPayeeParticipantIdEvt,
	TransferQueryPayeeNotFoundFailedEvt,
	TransferQueryPayerNotFoundFailedEvt,
	TransferQueryInvalidPayerParticipantIdEvt,
	TransferQueryInvalidPayerCheckFailedEvt,
	TransferPrepareLiquidityCheckFailedEvt,
	TransferUnableToGetTransferByIdEvt,
	TransferNotFoundEvt,
	TransferDuplicateCheckFailedEvt,
	TransferPayerNotFoundFailedEvt,
	TransferPayeeNotFoundFailedEvt,
	TransferHubNotFoundFailedEvt,
	TransferPayerNotApprovedEvt,
	TransferPayeeNotApprovedEvt,
	TransferHubAccountNotFoundFailedEvt,
	TransferPayerPositionAccountNotFoundFailedEvt,
	TransferPayerLiquidityAccountNotFoundFailedEvt,
	TransferPayeePositionAccountNotFoundFailedEvt,
	TransferPayeeLiquidityAccountNotFoundFailedEvt,
	TransferCancelReservationFailedEvt,
	TransferPrepareRequestTimedoutEvt,
	TransferFulfilCommittedRequestedTimedoutEvt,
	TransferFulfilPostCommittedRequestedTimedoutEvt,
	TransferQueryInvalidPayeeCheckFailedEvt,
	TransferCancelReservationAndCommitFailedEvt,
	TransferUnableToGetSettlementModelEvt,
	TransferSettlementModelNotFoundEvt,
	TransferPayerNetDebitCapCurrencyNotFoundEvt
} from "@mojaloop/platform-shared-lib-public-messages-lib";

const HUB_ID = "hub"; // move to shared lib

export class TransfersAggregate {
    private _logger: ILogger;
    private _auditClient: IAuditClient;
    private _transfersRepo: ITransfersRepository;
    private _messageProducer: IMessageProducer;
    private _participantAdapter: IParticipantsServiceAdapter;
    private _accountAndBalancesAdapter: IAccountsBalancesAdapter;
    private _metrics: IMetrics;
    private _histo: IHistogram;
    private _commandsCounter:ICounter;
    private _aandbHisto: IHistogram;
    private _participantsHisto: IHistogram;
    private _participantsCache: Map<string, { participant: IParticipant, timestamp: number }> = new Map<string, {
        participant: IParticipant;
        timestamp: number
    }>();
    private _settlementsAdapter: ISettlementsServiceAdapter;

    private _transfersCache: Map<string, ITransfer> = new Map<string, ITransfer>();
    private _batchCommands: Map<string, IDomainMessage> = new Map<string, IDomainMessage>();
    private _abBatchRequests: IAccountsBalancesHighLevelRequest[] = [];
    private _abCancelationBatchRequests: IAccountsBalancesHighLevelRequest[] = [];
    private _abBatchResponses: IAccountsBalancesHighLevelResponse[] = [];
    private _outputEvents: DomainEventMsg[] = [];

    constructor(
        logger: ILogger,
        transfersRepo: ITransfersRepository,
        participantsServiceAdapter: IParticipantsServiceAdapter,
        messageProducer: IMessageProducer,
        accountAndBalancesAdapter: IAccountsBalancesAdapter,
        metrics: IMetrics,
        settlementsAdapter: ISettlementsServiceAdapter
    ) {
        this._logger = logger.createChild(this.constructor.name);
        this._transfersRepo = transfersRepo;
        this._participantAdapter = participantsServiceAdapter;
        this._messageProducer = messageProducer;
        this._accountAndBalancesAdapter = accountAndBalancesAdapter;
        this._metrics = metrics;
        this._settlementsAdapter = settlementsAdapter;

        this._histo = metrics.getHistogram("TransfersAggregate", "TransfersAggregate calls", ["callName", "success"]);
        this._commandsCounter = metrics.getCounter("TransfersAggregate_CommandsProcessed", "Commands processed by the Transfers Aggregate", ["commandName"]);
        this._aandbHisto = metrics.getHistogram("TransfersAggregate_aandbAdapter", "A&B adapter timings on the Transfers Aggregate", ["callName", "success"]);
        this._participantsHisto = metrics.getHistogram("TransfersAggregate_participantsAdapter", "Participants adapter timings on the Transfers Aggregate", ["callName", "success"]);
    }

    async init(): Promise<void> {
        // TODO
        //await this._messageProducer.connect();
    }

    async processCommandBatch(cmdMessages: CommandMsg[]): Promise<void> {
        // TODO make sure we're not processing another batch already
        this._abBatchRequests = [];
        this._abCancelationBatchRequests = [];
        this._abBatchResponses = [];
        this._outputEvents = [];
        this._batchCommands.clear();

        try {
            // execute starts
            const execStarts_timerEndFn = this._histo.startTimer({ callName: "executeStarts"});
            for (const cmd of cmdMessages) {
                if(cmd.msgType !== MessageTypes.COMMAND) continue;
                await this._processCommand(cmd);
                this._commandsCounter.inc({commandName: cmd.msgName}, 1);
            }
            execStarts_timerEndFn({success:"true"});

            if(this._abBatchRequests.length<=0){
                return Promise.resolve();
            }

            // send to A&B
            const execAB_timerEndFn = this._histo.startTimer({ callName: "executeAandbProcessHighLevelBatch"});
            if(this._logger.isDebugEnabled()) this._logger.debug(`processCommandBatch() - before accountsAndBalancesAdapter.processHighLevelBatch()`);
            this._abBatchResponses = await this._accountAndBalancesAdapter.processHighLevelBatch(this._abBatchRequests);
            if(this._logger.isDebugEnabled()) this._logger.debug(`processCommandBatch() - after accountsAndBalancesAdapter.processHighLevelBatch()`);
            execAB_timerEndFn({success:"true"});

            // peek first and check count to establish no errors - or any other way to determine error

            // execute continues
            const executeContinues_timerEndFn = this._histo.startTimer({ callName: "executeContinues"});
            for (const abResponse of this._abBatchResponses) {
                await this._processAccountsAndBalancesResponse(abResponse);
            }
            executeContinues_timerEndFn({success:"true"});

            // if the continues queued cancellations, send then now
            if(this._abCancelationBatchRequests.length){
                // send cancellations to A&B
                const execAB_timerEndFn = this._histo.startTimer({ callName: "executeAandbProcessHighLevelCancelationBatch"});
                if(this._logger.isDebugEnabled()) this._logger.debug(`processCommandBatch() - before accountsAndBalancesAdapter.processHighLevelCancelationBatch()`);
                this._abBatchResponses = await this._accountAndBalancesAdapter.processHighLevelBatch(this._abCancelationBatchRequests);
                if(this._logger.isDebugEnabled()) this._logger.debug(`processCommandBatch() - after accountsAndBalancesAdapter.processHighLevelCancelationBatch()`);
                execAB_timerEndFn({success:"true"});
            }

        } catch (error: any) {
            this._logger.error(error);
            throw error;
        } finally {
            // flush in mem repositories
            await this._flush();

            // send resulting/output events
            await this._messageProducer.send(this._outputEvents);
            return Promise.resolve();
        }
    }

    private async _processCommand(cmd: CommandMsg): Promise<void> {
        // validate message
        this._ensureValidMessage(cmd);
        // cache command for later retrieval in continue methods
        this._batchCommands.set(cmd.payload.transferId, cmd);

        if (cmd.msgName === PrepareTransferCmd.name) {
            return this._prepareTransferStart(cmd as PrepareTransferCmd);
        } else if (cmd.msgName === CommitTransferFulfilCmd.name) {
            return this._fulfilTransferStart(cmd as CommitTransferFulfilCmd);
        // } else if (cmd.msgName === RejectTransferCmd.name) {
        //     return this._rejectTransferStart(cmd as RejectTransferCmd);
        // } else if (cmd.msgName === QueryTransferCmd.name) {
        //     return this._queryTransferStart(cmd as QueryTransferCmd);
        } else {
            // TODO throw unhandled cmd
        }
    }

    private async _processAccountsAndBalancesResponse(abResponse: IAccountsBalancesHighLevelResponse): Promise<any> {
        const request = this._abBatchRequests.find(value => value.requestId === abResponse.requestId);
        if (!request) {
            const err = new CheckLiquidityAndReserveFailedError("Could not find corresponding request for checkLiquidAndReserve IAccountsBalancesHighLevelResponse");
            this._logger.error(err);
            throw err;
        }

        const originalCmdMsg = this._batchCommands.get(request.transferId);
        if(!originalCmdMsg){
            const error = new Error("Original command not found in _processAccountsAndBalancesResponse()");
            this._logger.error(error);
            throw error;
        }

        // get transfer - null transfer is handled in the continue methods
        let transfer: ITransfer | null = null;
        try {
			transfer = await this._getTransfer(request.transferId);
		} catch(err: unknown) {
            const error = (err as Error).message;
			const errorMessage = `Unable to get transfer record for transferId: ${request.transferId} from repository - error: ${abResponse.errorMessage}`;
			this._logger.error(err, `${errorMessage}: ${error}`);
			const errorEvent = new TransferUnableToGetTransferByIdEvt({
				transferId: request.transferId,
				errorDescription: errorMessage
			});
            errorEvent.fspiopOpaqueState = originalCmdMsg.fspiopOpaqueState;
    
            this._outputEvents.push(errorEvent);
		}

        if (abResponse.requestType === AccountsBalancesHighLevelRequestTypes.checkLiquidAndReserve) {
            return this._prepareTransferContinue(abResponse, request, originalCmdMsg, transfer);
        } else if (abResponse.requestType === AccountsBalancesHighLevelRequestTypes.cancelReservationAndCommit) {
            return this._fulfilTTransferContinue(abResponse, request, originalCmdMsg, transfer);
        } else if (abResponse.requestType === AccountsBalancesHighLevelRequestTypes.cancelReservation) {
            throw new Error("not implemented");
        } else {
            // throw unhandled cmd
        }
    }

    private _ensureValidMessage(message: CommandMsg): void {
        if (!message.payload) {
            this._logger.error(`TransferCommandHandler: message payload has invalid format or value`);
            throw new InvalidMessagePayloadError();
        }

        if (!message.msgName) {
            this._logger.error(`TransferCommandHandler: message name is invalid`);
            throw new InvalidMessageTypeError();
        }

        if (message.msgType !== MessageTypes.COMMAND) {
            this._logger.error(`TransferCommandHandler: message type is invalid : ${message.msgType}`);
            throw new InvalidMessageTypeError();
        }
    }

    private async  _getTransfer(id:string):Promise<ITransfer | null>{
        let transfer: ITransfer | null = this._transfersCache.get(id) || null;
        if(transfer){
            return transfer;
        }

        transfer = await this._transfersRepo.getTransferById(id);
        if(transfer){
            this._transfersCache.set(id, transfer);
            return transfer;
        }

        return null;
    }

    private async _flush():Promise<void>{
        const timerEndFn = this._histo.startTimer({callName: "flush"});

        if(this._transfersCache.size){
            const entries = Array.from(this._transfersCache.values());
            await this._transfersRepo.storeTransfers(entries);
            this._transfersCache.clear();
        }

        timerEndFn({success: "true"});
    }

    private async _prepareTransferStart(message: PrepareTransferCmd): Promise<void> {
        if(this._logger.isDebugEnabled()) this._logger.debug(`prepareTransferStart() - Got transferPreparedReceivedEvt msg for transferId: ${message.payload.transferId}`);

		const hash = this.generateSha256({
			transferId: message.payload.transferId,
			payeeFspId: message.payload.payeeFsp,
			payerFspId: message.payload.payerFsp,
			amount: message.payload.amount,
			expirationTimestamp: message.payload.expiration
		});

		let getTransferRep:ITransfer | undefined;
		try {
            // TODO: fix since at the moment we only search in cache, otherwise we hit the dabatase in every request
			getTransferRep = this._transfersCache.get(message.payload.transferId);
		} catch(err: unknown) {
			const error = (err as Error).message;
			const errorMessage = `Unable to get transfer record for transferId: ${message.payload.transferId} from repository`;
			this._logger.error(err, `${errorMessage}: ${error}`);
			const errorEvent = new TransferUnableToGetTransferByIdEvt({
				transferId: message.payload.transferId,
				errorDescription: errorMessage
			});
            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);
            return;
		}

        // Duplicate Transfer POST use cases
		// TODO Use hash repository to fetch the hashes
		if(getTransferRep) {
			// if(getTransferRep.hash !== hash) {
			// 	const errorMessage = `Transfer hash for ${message.payload.transferId} doesn't match`;
			// 	this._logger.error(errorMessage);
			// 	const errorEvent = new TransferDuplicateCheckFailedEvt({
			// 		transferId: message.payload.transferId,
			// 		payerFspId: message.payload.payerFsp,
			// 		errorDescription: errorMessage
			// 	});
            //     errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            //     this._outputEvents.push(errorEvent);
            //     return;
			// }

			switch(getTransferRep.transferState) {
				case TransferState.RECEIVED:
				case TransferState.RESERVED: {
					// Ignore the request
					return;
				}
				case TransferState.COMMITTED:
				case TransferState.ABORTED: {
					// Send a response event to the payer
					const payload: TransferQueryResponseEvtPayload = {
						transferId: getTransferRep.transferId,
						transferState: getTransferRep.transferState,
						completedTimestamp: getTransferRep.completedTimestamp as unknown as string,
						fulfilment: getTransferRep.fulFillment as unknown as string,
						extensionList: getTransferRep.extensionList
					};

					const event = new TransferQueryResponseEvt(payload);

					event.fspiopOpaqueState = message.fspiopOpaqueState;
                    this._outputEvents.push(event);
					return;
				}
			}
		}
        
		let settlementModel: string | null = null;
		try {
			settlementModel = await this._settlementsAdapter.getSettlementModel(BigInt(message.payload.amount), message.payload.currencyCode, message.payload.currencyCode, message.payload.extensionList?.extension ? message.payload.extensionList.extension : []);
		} catch(err: unknown) {
			const error = (err as Error).message;
			const errorMessage = `Unable to get settlementModel for transferId: ${message.payload.transferId}`;
			this._logger.error(err, `${errorMessage}: ${error}`);
			const errorEvent = new TransferUnableToGetSettlementModelEvt({
				transferId: message.payload.transferId,
				amount: message.payload.amount,
				payerCurrency: message.payload.currencyCode,
				payeeCurrency: message.payload.currencyCode,
				extensionList: message.payload.extensionList ? (message.payload.extensionList).toString() : null,
				errorDescription: errorMessage
			});
            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);
            return;
		}

        if(!settlementModel) {
			const errorMessage = `SettlementModel not found for transferId: ${message.payload.transferId}`;
			this._logger.error(errorMessage);
			const errorEvent = new TransferSettlementModelNotFoundEvt({
				transferId: message.payload.transferId,
				amount: message.payload.amount,
				payerCurrency: message.payload.currencyCode,
				payeeCurrency: message.payload.currencyCode,
				extensionList: message.payload.extensionList ? (message.payload.extensionList).toString() : null,
				errorDescription: errorMessage
			});
            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);
            return;
		}

        const now = Date.now();

        const transfer: ITransfer = {
            createdAt: now,
            updatedAt: now,
            transferId: message.payload.transferId,
            payeeFspId: message.payload.payeeFsp,
            payerFspId: message.payload.payerFsp,
            amount: message.payload.amount,
            currencyCode: message.payload.currencyCode,
            ilpPacket: message.payload.ilpPacket,
            condition: message.payload.condition,
            expirationTimestamp: message.payload.expiration,
            transferState: TransferState.RECEIVED,
            hash: hash,
            fulFillment: null,
            completedTimestamp: null,
            extensionList: message.payload.extensionList,
            settlementModel: settlementModel,
            errorInformation: null,
        };

        if(this._logger.isDebugEnabled()) this._logger.debug("prepareTransferStart() - before getParticipants...");
        
        let participants:ITransferParticipants;
        try{
            participants = await this.getParticipantsInfo(transfer.payerFspId, transfer.payeeFspId, transfer.transferId);
        } catch (err: unknown) {
            let errorEvent:DomainErrorEventMsg;

            if(err instanceof HubNotFoundError) {
                errorEvent = new TransferHubNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayerParticipantNotFoundError) {
                errorEvent = new TransferPayerNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payerFspId: transfer.payerFspId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayeeParticipantNotFoundError) {
                errorEvent = new TransferPayeeNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payeeFspId: transfer.payerFspId,
                    errorDescription: (err as Error).message
                }) 
            } else {
                this._logger.error("Unable to handle _getParticipantsInfo error - _fulfilTransferStart");
                return;
            }

            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);
            return;
        }

        let participantAccounts:ITransferAccounts;
        try{
            participantAccounts = this.getTransferParticipantsAccounts(participants, transfer);;
        } catch (err: unknown) {
            let errorEvent:DomainErrorEventMsg;

            if(err instanceof HubAccountNotFoundError) {
                errorEvent = new TransferHubAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayerPositionAccountNotFoundError) {
                errorEvent = new TransferPayerPositionAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payerFspId: transfer.payerFspId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayerLiquidityAccountNotFoundError) {
                errorEvent = new TransferPayerLiquidityAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payerFspId: transfer.payerFspId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayeePositionAccountNotFoundError) {
                errorEvent = new TransferPayeePositionAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payeeFspId: transfer.payeeFspId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayeeLiquidityAccountNotFoundError) {
                errorEvent = new TransferPayeeLiquidityAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payeeFspId: transfer.payeeFspId,
                    errorDescription: (err as Error).message
                }) 
            } else {
                this._logger.error("Unable to handle _getTransferParticipantsAccounts error - _fulfilTransferStart");
                return;
            }

            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);
            return;
        }

        if(this._logger.isDebugEnabled()) this._logger.debug("prepareTransferStart() - after getParticipants");

        // TODO validate participants and accounts
        // TODO put net debit cap in the participant struct
        const payerNdc = "0";
        // Uncomment code below when participants has debitCaps in struct
		// const payerNdc = participants.payer.netDebitCaps((netDebitCap:any) => netDebitCap.currencyCode === transfer.currencyCode);

		if(!payerNdc) {
			const errorMessage = `Payer participant has no Net Debit Cap for currency: ${transfer.currencyCode}, participant ${transfer.payerFspId}`;
			this._logger.error(errorMessage);
			const errorEvent = new TransferPayerNetDebitCapCurrencyNotFoundEvt({
				transferId: transfer.transferId,
				payerFspId: transfer.payerFspId,
				currencyCode: transfer.currencyCode,
				errorDescription: errorMessage
			});
            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);
            return;
		}


        // set transfer in cache
        this._transfersCache.set(transfer.transferId, transfer);

        this._abBatchRequests.push({
            requestType: AccountsBalancesHighLevelRequestTypes.checkLiquidAndReserve,
            requestId: randomUUID(),
            payerPositionAccountId: participantAccounts.payerPosAccount.id,
            payerLiquidityAccountId: participantAccounts.payerLiqAccount.id,
            hubJokeAccountId: participantAccounts.hubAccount.id,
            transferId: transfer.transferId,
            transferAmount: transfer.amount,
            currencyCode: transfer.currencyCode,
            payerNetDebitCap: payerNdc,
            payeePositionAccountId: null,
        });

        if(this._logger.isDebugEnabled()) this._logger.debug("prepareTransferStart() - complete");
    }

    private async _prepareTransferContinue(
        abResponse: IAccountsBalancesHighLevelResponse,
        request: IAccountsBalancesHighLevelRequest,
        originalCmdMsg:IDomainMessage,
        transfer: ITransfer | null
    ): Promise<any> {
        if (!transfer) {
			const errorMessage = `Could not find corresponding transfer with id: ${request.transferId} for checkLiquidAndReserve IAccountsBalancesHighLevelResponse`;
			this._logger.error(errorMessage);
			let errorEvent = new TransferNotFoundEvt({
				transferId: originalCmdMsg.payload.transferId,
				errorDescription: errorMessage
			});

            try {
                await this._cancelTransfer(originalCmdMsg.payload.transferId);
            } catch(err: unknown) {
                const error = (err as Error).message;
                const errorMessage = `Unable to cancel reservation with transferId: ${originalCmdMsg.payload.transferId}`;
                this._logger.error(err, `${errorMessage}: ${error}`);
                errorEvent = new TransferCancelReservationFailedEvt({
                    transferId: originalCmdMsg.payload.transferId,
                    errorDescription: errorMessage
                });
            }

            errorEvent.fspiopOpaqueState = originalCmdMsg.fspiopOpaqueState;
    
            this._outputEvents.push(errorEvent);
            return;
        }
        if(this._logger.isDebugEnabled()) this._logger.debug(`prepareTransferContinue() - Called for transferId: ${transfer.transferId}`);

        if (!abResponse.success) {
            const err = new CheckLiquidityAndReserveFailedError(`Unable to check liquidity and reserve for transferId: ${request.transferId} - error: ${abResponse.errorMessage}`);
            const error = (err as Error).message;
			const errorMessage = `Unable to check liquidity and reserve for transferId: ${transfer.transferId}`;
			this._logger.error(err, `${errorMessage}: ${error}`);
            const errorEvent = new TransferPrepareLiquidityCheckFailedEvt({
				transferId: transfer.transferId,
				payerFspId: transfer.payerFspId,
				amount: transfer.amount,
				currency: transfer.currencyCode,
				errorDescription: errorMessage
			})

            errorEvent.fspiopOpaqueState = originalCmdMsg.fspiopOpaqueState;
            
			this._outputEvents.push(errorEvent);
            return;
        }

        // TODO validate type
        const message = originalCmdMsg;// as PrepareTransferCmd;

        // update transfer and cache it
        transfer.transferState = TransferState.RESERVED;
        this._transfersCache.set(transfer.transferId, transfer);

        const payload: TransferPreparedEvtPayload = {
            transferId: message.payload.transferId,
            payeeFsp: message.payload.payeeFsp,
            payerFsp: message.payload.payerFsp,
            amount: message.payload.amount,
            currencyCode: message.payload.currencyCode,
            ilpPacket: message.payload.ilpPacket,
            condition: message.payload.condition,
            expiration: message.payload.expiration,
            extensionList: message.payload.extensionList
        };

        const event = new TransferPreparedEvt(payload);

        event.fspiopOpaqueState = message.fspiopOpaqueState;

        if(this._logger.isDebugEnabled()) this._logger.debug(`prepareTransferContinue() - completed for transferId: ${transfer.transferId}`);

        this._outputEvents.push(event);
    }

    private async _fulfilTransferStart(message: CommitTransferFulfilCmd): Promise<any> {
        if(this._logger.isDebugEnabled()) this._logger.debug(`fulfilTransfer() - Got transferFulfilCommittedEvt msg for transferId: ${message.payload.transferId}`);

        let participantTransferAccounts: ITransferAccounts | null = null;

        let transfer: ITransfer | null = null;
        try {
			transfer = await this._getTransfer(message.payload.transferId);
		} catch(err: unknown) {
			const error = (err as Error).message;
			const errorMessage = `Unable to get transfer record for transferId: ${message.payload.transferId} from repository`;
			this._logger.error(err, `${errorMessage}: ${error}`);
			const errorEvent = new TransferUnableToGetTransferByIdEvt({
                transferId: message.payload.transferId,
				errorDescription: errorMessage
			});
            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
    
            this._outputEvents.push(errorEvent);
            
		}

        if(!transfer) {
			const errorMessage = `Could not find corresponding transfer with id: ${message.payload.transferId} for checkLiquidAndReserve IAccountsBalancesHighLevelResponse`;
			this._logger.error(errorMessage);
			let errorEvent = new TransferNotFoundEvt({
				transferId: message.payload.transferId,
				errorDescription: errorMessage
			});
            
            try {
                await this._cancelTransfer(message.payload.transferId);
            } catch(err: unknown) {
                const error = (err as Error).message;
                const errorMessage = `Unable to cancel reservation with transferId: ${message.payload.transferId}`;
                this._logger.error(err, `${errorMessage}: ${error}`);
                errorEvent = new TransferCancelReservationFailedEvt({
                    transferId: message.payload.transferId,
                    errorDescription: errorMessage
                });
            }

            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);
            return;
        }

        let participants:ITransferParticipants;
        try {
            participants = await this.getParticipantsInfo(transfer.payerFspId, transfer.payeeFspId, transfer.transferId);
        } catch (err: unknown) {
            let errorEvent:DomainErrorEventMsg;

            if(err instanceof HubNotFoundError) {
                errorEvent = new TransferHubNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayerParticipantNotFoundError) {
                errorEvent = new TransferPayerNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payerFspId: transfer.payerFspId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayeeParticipantNotFoundError) {
                errorEvent = new TransferPayeeNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payeeFspId: transfer.payerFspId,
                    errorDescription: (err as Error).message
                }) 
            } else {
                this._logger.error("Unable to handle getParticipantsInfo error - _fulfilTransferStart");
                return;
            }

            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);

            try {
                await this._cancelTransfer(transfer.transferId);
            } catch(err: unknown) {
                const error = (err as Error).message;
                const errorMessage = `Unable to cancel reservation with transferId: ${transfer.transferId}`;
                this._logger.error(err, `${errorMessage}: ${error}`);
                errorEvent = new TransferCancelReservationFailedEvt({
                    transferId: transfer.transferId,
                    errorDescription: errorMessage
                });
            }
            return;
        }

        try{
            participantTransferAccounts = this.getTransferParticipantsAccounts(participants, transfer);;
        } catch (err: unknown) {
            let errorEvent:DomainErrorEventMsg;

            if(err instanceof HubAccountNotFoundError) {
                errorEvent = new TransferHubAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayerPositionAccountNotFoundError) {
                errorEvent = new TransferPayerPositionAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payerFspId: transfer.payerFspId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayerLiquidityAccountNotFoundError) {
                errorEvent = new TransferPayerLiquidityAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payerFspId: transfer.payerFspId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayeePositionAccountNotFoundError) {
                errorEvent = new TransferPayeePositionAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payeeFspId: transfer.payeeFspId,
                    errorDescription: (err as Error).message
                }) 
            } else if (err instanceof PayeeLiquidityAccountNotFoundError) {
                errorEvent = new TransferPayeeLiquidityAccountNotFoundFailedEvt({
                    transferId: transfer.transferId,
                    payeeFspId: transfer.payeeFspId,
                    errorDescription: (err as Error).message
                }) 
            } else {
                this._logger.error("Unable to handle _getTransferParticipantsAccounts error - _fulfilTransferStart");
                return;
            }

            try {
                await this._cancelTransfer(transfer.transferId);
            } catch(err: unknown) {
                const error = (err as Error).message;
                const errorMessage = `Unable to cancel reservation with transferId: ${transfer.transferId}`;
                this._logger.error(err, `${errorMessage}: ${error}`);
                errorEvent = new TransferCancelReservationFailedEvt({
                    transferId: transfer.transferId,
                    errorDescription: errorMessage
                });
            }

            errorEvent.fspiopOpaqueState = message.fspiopOpaqueState;
            this._outputEvents.push(errorEvent);
            return;
        }

        // set transfer in cache
        // this._transfersCache.set(transfer.transferId, transfer);

        this._abBatchRequests.push({
            requestType: AccountsBalancesHighLevelRequestTypes.cancelReservationAndCommit,
            requestId: randomUUID(),
            payerPositionAccountId: participantTransferAccounts.payerPosAccount.id,
            payeePositionAccountId: participantTransferAccounts.payeePosAccount.id,
            hubJokeAccountId: participantTransferAccounts.hubAccount.id,
            transferId: transfer.transferId,
            transferAmount: transfer.amount,
            currencyCode: transfer.currencyCode,
            payerNetDebitCap: null,
            payerLiquidityAccountId: null
        });

        if(this._logger.isDebugEnabled()) this._logger.debug(`fulfilTransfer() - completed for transferId: ${message.payload.transferId}`);
    }

    private async _fulfilTTransferContinue(
        abResponse: IAccountsBalancesHighLevelResponse,
        request: IAccountsBalancesHighLevelRequest,
        originalCmdMsg:IDomainMessage,
        transfer: ITransfer | null
    ): Promise<void> {
        if (!transfer) {
			const errorMessage = `Could not find corresponding transfer with id: ${request.transferId} for _fulfilTTransferContinue IAccountsBalancesHighLevelResponse`;
			this._logger.error(errorMessage);
			let errorEvent = new TransferNotFoundEvt({
				transferId: originalCmdMsg.payload.transferId,
				errorDescription: errorMessage
			});

            try {
                await this._cancelTransfer(originalCmdMsg.payload.transferId);
            } catch(err: unknown) {
                const error = (err as Error).message;
                const errorMessage = `Unable to cancel reservation with transferId: ${originalCmdMsg.payload.transferId}`;
                this._logger.error(err, `${errorMessage}: ${error}`);
                errorEvent = new TransferCancelReservationFailedEvt({
                    transferId: originalCmdMsg.payload.transferId,
                    errorDescription: errorMessage
                });
            }

            errorEvent.fspiopOpaqueState = originalCmdMsg.fspiopOpaqueState;
    
            this._outputEvents.push(errorEvent);
            return;
        }

        if(this._logger.isDebugEnabled()) this._logger.debug(`fulfilTTransferContinue() - started for transferId: ${transfer.transferId}`);

        if (!abResponse.success) {
            const err = new CheckLiquidityAndReserveFailedError(`Unable to cancelReservationAndCommit for transferId: ${request.transferId} - error: ${abResponse.errorMessage}`);
            this._logger.error(err);
            transfer.transferState = TransferState.REJECTED;
            this._transfersCache.set(transfer.transferId, transfer);

			const errorMessage = `Unable to commit transfer for transferId: ${request.transferId}`;
			let errorEvent = new TransferCancelReservationAndCommitFailedEvt({
				transferId: request.transferId,
				errorDescription: errorMessage
			});

            try {
                await this._cancelTransfer(transfer.transferId);
            } catch(err: unknown) {
                const error = (err as Error).message;
                const errorMessage = `Unable to cancel reservation with transferId: ${transfer.transferId}`;
                this._logger.error(err, `${errorMessage}: ${error}`);
                errorEvent = new TransferCancelReservationFailedEvt({
                    transferId: transfer.transferId,
                    errorDescription: errorMessage
                });
            }

            errorEvent.fspiopOpaqueState = originalCmdMsg.fspiopOpaqueState;
    
            this._outputEvents.push(errorEvent);

        }

        // TODO if failed, queue a cancelReservation request to this._abCancelationBatchRequests and add the error event to the events queue
        // this._abCancelationBatchRequests.push({
        //     requestType: AccountsBalancesHighLevelRequestTypes.cancelReservation,
        //     ...

        // TODO validate type
        const message = originalCmdMsg;// as PrepareTransferCmd;


        transfer.updatedAt = Date.now();
        transfer.transferState = TransferState.COMMITTED;
        transfer.fulFillment = message.payload.fulfilment;
        transfer.completedTimestamp = message.payload.completedTimestamp;
        transfer.extensionList = message.payload.extensionList;

        this._transfersCache.set(transfer.transferId, transfer);

        const event: TransferCommittedFulfiledEvt = new TransferCommittedFulfiledEvt({
            transferId: message.payload.transferId,
            fulfilment: message.payload.fulfilment,
            completedTimestamp: message.payload.completedTimestamp,
            extensionList: message.payload.extensionList,
            payerFspId: transfer.payerFspId,
            payeeFspId: transfer.payeeFspId,
            amount: transfer.amount,
            currencyCode: transfer.currencyCode,
            settlementModel: transfer.settlementModel,
        });

        // carry over opaque state fields
        event.fspiopOpaqueState = message.fspiopOpaqueState;

        this._logger.debug("transferPreparedReceivedEvt completed for transferId: " + transfer.transferId);

        this._outputEvents.push(event);
        if(this._logger.isDebugEnabled()) this._logger.debug(`fulfilTTransferContinue() - completed for transferId: ${transfer.transferId}`);
    }

    private async getParticipantsInfo(payerFspId: string, payeeFspId: string, transferId: string): Promise<ITransferParticipants> {
        // TODO get all participants in a single call with participantsClient.getParticipantsByIds()

        let hub: IParticipant;
        let payer: IParticipant;
        let payee: IParticipant;

        let hubCache: {
            participant: IParticipant,
            timestamp: number
        } | undefined = this._participantsCache.get(HUB_ID);
        if (!hubCache) {
            const foundHub = await this._participantAdapter.getParticipantInfo(HUB_ID);
            if (!foundHub) {
                const errorMessage = "Hub not found " + HUB_ID + " for transfer " + transferId;
                this._logger.error(errorMessage);
                throw new HubNotFoundError(errorMessage);
            }
            this._participantsCache.set(HUB_ID, {participant: foundHub, timestamp: Date.now()});
            hub = foundHub;
        } else {
            hub = hubCache.participant;
        }

        let payerCache: {
            participant: IParticipant,
            timestamp: number
        } | undefined = this._participantsCache.get(payerFspId);
        if (!payerCache) {
            const foundPayer = await this._participantAdapter.getParticipantInfo(payerFspId);
            if (!foundPayer) {
                const errorMessage = "Payer participant not found " + payerFspId + " for transfer " + transferId;
                this._logger.error(errorMessage);
                throw new PayerParticipantNotFoundError(errorMessage);
            }
            this._participantsCache.set(payerFspId, {participant: foundPayer, timestamp: Date.now()});
            payer = foundPayer;
        } else {
            payer = payerCache.participant;
        }

        let payeeCache: {
            participant: IParticipant,
            timestamp: number
        } | undefined = this._participantsCache.get(payeeFspId);
        if (!payeeCache) {
            const foundPayee = await this._participantAdapter.getParticipantInfo(payeeFspId);
            if (!foundPayee) {
                const errorMessage = "Payee participant not found " + payeeFspId + " for transfer " + transferId;
                this._logger.error(errorMessage);
                throw new PayeeParticipantNotFoundError(errorMessage);
            }
            this._participantsCache.set(payeeFspId, {participant: foundPayee, timestamp: Date.now()});
            payee = foundPayee
        } else {
            payee = payeeCache.participant;
        }

        return {
            hub: hub,
            payer: payer,
            payee: payee
        };
    }


    private getTransferParticipantsAccounts(transferParticipants: ITransferParticipants, transfer: ITransfer): ITransferAccounts {

        const {hub, payer: transferPayerParticipant, payee: transferPayeeParticipant} = transferParticipants;

        const hubAccount = hub.participantAccounts.find((value: IParticipantAccount) => value.type === AccountType.HUB && value.currencyCode === transfer.currencyCode);
        if(!hubAccount) {
			const errorMessage = "Hub account not found for transfer " + transfer.transferId;
            this._logger.error(errorMessage);
            throw new HubAccountNotFoundError(errorMessage);
        }
    
        const payerPosAccount = transferPayerParticipant.participantAccounts.find((value: IParticipantAccount) => value.type === AccountType.POSITION && value.currencyCode === transfer.currencyCode);
        if(!payerPosAccount) {
			const errorMessage = `Payer position account not found: transferId: ${transfer.transferId}, payer: ${transfer.payerFspId}`;
            this._logger.error(errorMessage);
            throw new PayerPositionAccountNotFoundError(errorMessage);
        }

        const payerLiqAccount = transferPayerParticipant.participantAccounts.find((value: IParticipantAccount) => value.type === AccountType.SETTLEMENT && value.currencyCode === transfer.currencyCode);
        if(!payerLiqAccount) {
			const errorMessage = `Payer liquidity account not found: transferId: ${transfer.transferId}, payer: ${transfer.payerFspId}`;
            this._logger.error(errorMessage);
            throw new PayerLiquidityAccountNotFoundError(errorMessage);
        }
        
        const payeePosAccount = transferPayeeParticipant.participantAccounts.find((value: IParticipantAccount) => value.type === AccountType.POSITION && value.currencyCode === transfer.currencyCode);
        if(!payeePosAccount) {
			const errorMessage = `Payee position account not found: transferId: ${transfer.transferId}, payee: ${transfer.payeeFspId}`;
            this._logger.error(errorMessage);
            throw new PayeePositionAccountNotFoundError(errorMessage);
        }
    
        const payeeLiqAccount = transferPayeeParticipant.participantAccounts.find((value: IParticipantAccount) => value.type === AccountType.SETTLEMENT && value.currencyCode === transfer.currencyCode);
        if(!payeeLiqAccount) {
			const errorMessage = `Payee liquidity account not found: transferId: ${transfer.transferId}, payee: ${transfer.payeeFspId}`;
            this._logger.error(errorMessage);
            throw new PayeeLiquidityAccountNotFoundError(errorMessage);
        }

        return {
            hubAccount: hubAccount,
            payerPosAccount: payerPosAccount,
            payerLiqAccount: payerLiqAccount,
            payeePosAccount: payeePosAccount,
            payeeLiqAccount: payeeLiqAccount
        };
    }

    private async validateParticipant(participantId: string | null): Promise<void> {
        // TODO: use this when all flags are available
        // if (participantId) {
        //     const participant = await this._participantAdapter.getParticipantInfo(participantId);

        //     if (!participant) {
        //         this._logger.debug(`No participant found`);
        //         throw new NoSuchParticipantError();
        //     }

        //     if (!participant.isActive) {
        //         this._logger.debug(`${participant.id} is not active`);
        //         throw new RequiredParticipantIsNotActive();
        //     }
        // }

        return;
    }

    private async _cancelTransfer(transferId: string) {
        try {
            const transfer = this._transfersCache.get(transferId);

            if(!transfer) {
                const errorMessage = `Could not find corresponding transfer with id: ${transferId} for cancelTransfer`;
                this._logger.error(errorMessage);
                throw new TransferNotFoundError(errorMessage);
            }
            const participants = await this.getParticipantsInfo(transfer.payerFspId, transfer.payeeFspId, transfer.transferId);
      
            const participantTransferAccounts = this.getTransferParticipantsAccounts(participants, transfer);

            this._abCancelationBatchRequests.push({
                requestType: AccountsBalancesHighLevelRequestTypes.cancelReservation,
                requestId: randomUUID(),
                payerPositionAccountId: participantTransferAccounts.payerPosAccount.id,
                payerLiquidityAccountId: participantTransferAccounts.payerLiqAccount.id,
                hubJokeAccountId: participantTransferAccounts.hubAccount.id,
                transferId: transfer.transferId,
                transferAmount: transfer.amount,
                currencyCode: transfer.currencyCode,
                payerNetDebitCap: null,
                payeePositionAccountId: null,
            });

            transfer.transferState = TransferState.REJECTED;

            await this._transfersRepo.updateTransfer(transfer);
        } catch (err: unknown) {
            const errorMessage = `Error cancelling transfer ${transferId} ${err}`;
            this._logger.error(err, errorMessage);
            throw new UnableToCancelTransferError(errorMessage);
        }
    }

    private generateSha256(object:{[key: string]: string | number}):string {
		const hashSha256 = createHash('sha256')

		// updating data
		.update(JSON.stringify(object))

		// Encoding to be used
		.digest("base64");

		// remove trailing '=' as per specification
		return hashSha256.slice(0, -1);
	}
}
