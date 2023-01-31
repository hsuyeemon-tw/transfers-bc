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

 --------------
 ******/

"use strict";


import { TransfersAggregate, IParticipantService, ITransfersRepository }  from "@mojaloop/transfers-bc-domain-lib";
import { ParticipantAdapter, MongoTransfersRepo } from "@mojaloop/transfers-bc-implementations";
import {TransfersEventHandler} from "@mojaloop/transfers-bc-event-handler-svc/dist/handler";
import {existsSync} from "fs";
import {IAuditClient} from "@mojaloop/auditing-bc-public-types-lib";
import {ILogger, LogLevel} from "@mojaloop/logging-bc-public-types-lib";
import {
	AuditClient,
	KafkaAuditClientDispatcher,
	LocalAuditClientCryptoProvider
} from "@mojaloop/auditing-bc-client-lib";
import {KafkaLogger} from "@mojaloop/logging-bc-client-lib";
import {
	MLKafkaJsonConsumer,
	MLKafkaJsonProducer,
	MLKafkaJsonConsumerOptions,
	MLKafkaJsonProducerOptions
} from "@mojaloop/platform-shared-lib-nodejs-kafka-client-lib";
import {IMessageConsumer, IMessageProducer} from "@mojaloop/platform-shared-lib-messaging-types-lib";
import {TransfersCommandHandler} from "./handler";
import {
	AuthenticatedHttpRequester,
	IAuthenticatedHttpRequester
} from "@mojaloop/security-bc-client-lib";

/* import configs - other imports stay above */
import configClient from "./config";
import path from "path";
const BC_NAME = configClient.boundedContextName;
const APP_NAME = configClient.applicationName;
const APP_VERSION = configClient.applicationVersion;
const PRODUCTION_MODE = process.env["PRODUCTION_MODE"] || false;
const LOG_LEVEL: LogLevel = process.env["LOG_LEVEL"] as LogLevel || LogLevel.DEBUG;

const KAFKA_URL = process.env["KAFKA_URL"] || "localhost:9092";

const KAFKA_AUDITS_TOPIC = process.env["KAFKA_AUDITS_TOPIC"] || "audits";
const KAFKA_LOGS_TOPIC = process.env["KAFKA_LOGS_TOPIC"] || "logs";
const AUDIT_KEY_FILE_PATH = process.env["AUDIT_KEY_FILE_PATH"] || path.join(__dirname, "../dist/tmp_audit_key_file");

const kafkaConsumerOptions: MLKafkaJsonConsumerOptions = {
	kafkaBrokerList: KAFKA_URL,
	kafkaGroupId: `${BC_NAME}_${APP_NAME}`
};

const kafkaProducerOptions: MLKafkaJsonProducerOptions = {
	kafkaBrokerList: KAFKA_URL
};

let globalLogger: ILogger;

// Participant service
const PARTICIPANT_SVC_BASEURL = process.env["PARTICIPANT_SVC_BASEURL"] || "http://localhost:3010";
const fixedToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Iml2SC1pVUVDRHdTVnVGS0QtRzdWc0MzS0pnLXN4TFgteWNvSjJpOTFmLTgifQ.eyJ0eXAiOiJCZWFyZXIiLCJhenAiOiJzZWN1cml0eS1iYy11aSIsInJvbGVzIjpbIjI2ODBjYTRhLTRhM2EtNGU5YS1iMWZhLTY1MDAyMjkyMTAwOSJdLCJpYXQiOjE2NzE1MzYyNTYsImV4cCI6MTY3MjE0MTA1NiwiYXVkIjoibW9qYWxvb3Audm5leHQuZGVmYXVsdF9hdWRpZW5jZSIsImlzcyI6Imh0dHA6Ly9sb2NhbGhvc3Q6MzIwMS8iLCJzdWIiOiJ1c2VyOjp1c2VyIiwianRpIjoiMWYxMzhkZjctMjg1OC00MWNmLThkYTctYTRiYTNhZTZkMGZlIn0.WSn0M73nMXRQhZ1nzpc2YEOBcV5uUupR5aMvxhiAHKylGChzB_gEtikijnUFDw2o5tVYVeiyeKe2_CRPOQ5KTt3VxCBXheMIxekmNE6U9pZY5fsUrphfMb5j886IMiiR-ai25-MplCoaKmsbd1M4HFT8bcjongiXFVkSUmKgG4Q1YyrjnROxH5-xMjDGL1icZNlTjRxYC5BbfiTfw8TSgfdrBVY_v7tE-MRdoI6bVaMfwib_bNfpTHMLt0tx2ca90WKU0IuXOqNMuZv0s-AwmstVA0qiM10Jc4p5A7nQjnLH3cX_X17Gz6lFd8hpDzl7gtSJGD-YvCg-xQn_cGAO0g";
export class Service {
	static logger: ILogger;
	static auditClient: IAuditClient;
	static messageConsumer: IMessageConsumer;
	static messageProducer: IMessageProducer;
	static handler: TransfersCommandHandler;
	static aggregate: TransfersAggregate;
	static participantService: IParticipantService;
	static transfersRepo: ITransfersRepository;

	static async start(
		logger?: ILogger,
		auditClient?: IAuditClient,
		messageConsumer?: IMessageConsumer,
		messageProducer?: IMessageProducer,
		participantService?: IParticipantService,
		transfersRepo?: ITransfersRepository,
		aggregate?: TransfersAggregate
	): Promise<void> {
		console.log(`Service starting with PID: ${process.pid}`);

		/// start config client - this is not mockable (can use STANDALONE MODE if desired)
		await configClient.init();
		await configClient.bootstrap(true);
		await configClient.fetch();

		if (!logger) {
			logger = new KafkaLogger(
				BC_NAME,
				APP_NAME,
				APP_VERSION,
				kafkaProducerOptions,
				KAFKA_LOGS_TOPIC,
				LOG_LEVEL
			);
			await (logger as KafkaLogger).init();
		}
		globalLogger = this.logger = logger;

		/// start auditClient
		if (!auditClient) {
			if (!existsSync(AUDIT_KEY_FILE_PATH)) {
				if (PRODUCTION_MODE) process.exit(9);
				// create e tmp file
				LocalAuditClientCryptoProvider.createRsaPrivateKeyFileSync(AUDIT_KEY_FILE_PATH, 2048);
			}
			const auditLogger = logger.createChild("auditDispatcher");
			auditLogger.setLogLevel(LogLevel.INFO);

			const cryptoProvider = new LocalAuditClientCryptoProvider(AUDIT_KEY_FILE_PATH);
			const auditDispatcher = new KafkaAuditClientDispatcher(kafkaProducerOptions, KAFKA_AUDITS_TOPIC, auditLogger);
			// NOTE: to pass the same kafka logger to the audit client, make sure the logger is started/initialised already
			auditClient = new AuditClient(BC_NAME, APP_NAME, APP_VERSION, cryptoProvider, auditDispatcher);
			await auditClient.init();
		}
		this.auditClient = auditClient;

		if(!messageConsumer){
			const consumerHandlerLogger = logger.createChild("handlerConsumer");
			consumerHandlerLogger.setLogLevel(LogLevel.INFO);
			messageConsumer = new MLKafkaJsonConsumer(kafkaConsumerOptions, consumerHandlerLogger);
		}
		this.messageConsumer = messageConsumer;

		if (!messageProducer) {
			const producerLogger = logger.createChild("producerLogger");
			producerLogger.setLogLevel(LogLevel.INFO);
			messageProducer = new MLKafkaJsonProducer(kafkaProducerOptions, producerLogger);
			await messageProducer.connect();
		}
		this.messageProducer = messageProducer;

		if (!transfersRepo) {
			const MONGO_URL = process.env["MONGO_URL"] || "mongodb://root:mongoDbPas42@localhost:27017/";
			const DB_NAME_TRANSFERS = process.env.TRANSFERS_DB_NAME ?? "transfers";

			transfersRepo = new MongoTransfersRepo(logger,MONGO_URL, DB_NAME_TRANSFERS);

			await transfersRepo.init();
			logger.info("Transfer Registry Repo Initialized");
		}
		this.transfersRepo = transfersRepo;



		if (!participantService) {
			const participantLogger = logger.createChild("participantLogger");

			const AUTH_TOKEN_ENPOINT = "http://localhost:3201/token";
			const USERNAME = "user";                
			const PASSWORD = "superPass";          
			const CLIENT_ID = "security-bc-ui";    
			const PARTICIPANTS_BASE_URL: string = "http://localhost:3010";
			const HTTP_CLIENT_TIMEOUT_MS: number = 10_000;

			const authRequester:IAuthenticatedHttpRequester = new AuthenticatedHttpRequester(logger, AUTH_TOKEN_ENPOINT);

			authRequester.setUserCredentials(CLIENT_ID, USERNAME, PASSWORD);
			participantLogger.setLogLevel(LogLevel.INFO);
			participantService = new ParticipantAdapter(participantLogger, PARTICIPANTS_BASE_URL, authRequester, HTTP_CLIENT_TIMEOUT_MS);
		}
		this.participantService = participantService;

		if (!aggregate) {
			const producerLogger = logger.createChild("producerLogger");
			producerLogger.setLogLevel(LogLevel.INFO);
			aggregate = new TransfersAggregate(logger, transfersRepo, participantService, messageProducer);
		}
		this.aggregate = aggregate;

		// create handler and start it
		this.handler = new TransfersCommandHandler(this.logger, this.auditClient, this.messageConsumer, this.aggregate);
		await this.handler.start();

		this.logger.info("Service started");
	}

	static async stop() {
		if (this.handler) await this.handler.stop();
		if (this.messageConsumer) await this.messageConsumer.destroy(true);

		if (this.auditClient) await this.auditClient.destroy();
		if (this.logger && this.logger instanceof KafkaLogger) await this.logger.destroy();
	}
}


/**
 * process termination and cleanup
 */

async function _handle_int_and_term_signals(signal: NodeJS.Signals): Promise<void> {
	console.info(`Service - ${signal} received - cleaning up...`);
	let clean_exit = false;
	setTimeout(args => {
		clean_exit || process.abort();
	}, 5000);

	// call graceful stop routine
	await Service.stop();

	clean_exit = true;
	process.exit();
}

//catches ctrl+c event
process.on("SIGINT", _handle_int_and_term_signals);
//catches program termination event
process.on("SIGTERM", _handle_int_and_term_signals);

//do something when app is closing
process.on("exit", async () => {
	console.info("Microservice - exiting...");
});
process.on("uncaughtException", (err: Error) => {
	console.error(err, "UncaughtException - EXITING...");
	process.exit(999);
});