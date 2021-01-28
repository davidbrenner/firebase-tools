import * as _ from "lodash";
import * as clc from "cli-color";

import { FirebaseError } from "./error";
import * as logger from "./logger";
import * as track from "./track";
import * as utils from "./utils";
import * as cloudfunctions from "./gcp/cloudfunctions";
import * as pollOperations from "./pollOperations";
import { promptOnce } from "./prompt";
import * as deploymentTool from "./deploymentTool";

// TODO: Get rid of this when switching to use operation-poller.
export interface Operation {
  name: string;
  type: string;
  funcName: string;
  done: boolean;
  eventType?: string;
  trigger?: {
    eventTrigger?: any;
    httpsTrigger?: any;
  };
  retryFunction?: () => Promise<any>;
  triggerUrl?: string;
  error?: { code: number; message: string };
}

export interface CloudFunctionTrigger {
  name: string;
  sourceUploadUrl?: string;
  labels: { [key: string]: string };
  environmentVariables: { [key: string]: string };
  entryPoint: string;
  runtime?: string;
  vpcConnector?: string;
  vpcConnectorEgressSettings?: string;
  ingressSettings?: string;
  availableMemoryMb?: number;
  timeout?: number;
  maxInstances?: number;
  serviceAccountEmail?: string;
  httpsTrigger?: any;
  eventTrigger?: any;
  failurePolicy?: {};
  schedule?: object;
  timeZone?: string;
  regions?: string[];
}

export interface RegionMap {
  [region: string]: CloudFunctionTrigger[];
}

export interface RegionalDeployment {
  region: string;
  sourceToken?: string;
  firstFunctionDeployment?: CloudFunctionTrigger;
  functionsToCreate: CloudFunctionTrigger[];
  functionsToUpdate: CloudFunctionTrigger[];
  schedulesToCreateOrUpdate: CloudFunctionTrigger[];
}

export interface DeploymentPlan {
  regionalDeployments: RegionalDeployment[];
  functionsToDelete: string[];
  schedulesToDelete: string[];
}

export function functionMatchesAnyGroup(fnName: string, filterGroups: string[][]) {
  if (!filterGroups.length) {
    return true;
  }
  for (const groupChunks of filterGroups) {
    if (functionMatchesGroup(fnName, groupChunks)) {
      return true;
    }
  }
  return false;
}

export function functionMatchesGroup(functionName: string, groupChunks: string[]): boolean {
  const last = _.last(functionName.split("/"));
  if (!last) {
    return false;
  }
  const functionNameChunks = last.split("-").slice(0, groupChunks.length);
  return _.isEqual(groupChunks, functionNameChunks);
}

export function getFilterGroups(options: any): string[][] {
  if (!options.only) {
    return [];
  }

  let opts;
  return _.chain(options.only.split(","))
    .filter((filter) => {
      opts = filter.split(":");
      return opts[0] === "functions" && opts[1];
    })
    .map((filter) => {
      return filter.split(":")[1].split(/[.-]/);
    })
    .value();
}

export function getReleaseNames(
  uploadNames: string[],
  existingNames: string[],
  functionFilterGroups: string[][]
): string[] {
  if (functionFilterGroups.length === 0) {
    return uploadNames;
  }

  const allFunctions = _.union(uploadNames, existingNames);
  return _.filter(allFunctions, (functionName) => {
    return _.some(
      _.map(functionFilterGroups, (groupChunks) => {
        return functionMatchesGroup(functionName, groupChunks);
      })
    );
  });
}

export function logFilters(
  existingNames: string[],
  releaseNames: string[],
  functionFilterGroups: string[][]
): void {
  if (functionFilterGroups.length === 0) {
    return;
  }

  logger.debug("> [functions] filtering triggers to: " + JSON.stringify(releaseNames, null, 2));
  track("Functions Deploy with Filter", "", releaseNames.length);

  let list;
  if (existingNames.length > 0) {
    list = _.map(existingNames, (name) => {
      return getFunctionName(name) + "(" + getRegion(name) + ")";
    }).join(", ");
    utils.logBullet(clc.bold.cyan("functions: ") + "current functions in project: " + list);
  }
  if (releaseNames.length > 0) {
    list = _.map(releaseNames, (name) => {
      return getFunctionName(name) + "(" + getRegion(name) + ")";
    }).join(", ");
    utils.logBullet(clc.bold.cyan("functions: ") + "uploading functions in project: " + list);
  }

  const allFunctions = _.union(releaseNames, existingNames);
  const unmatchedFilters = _.chain(functionFilterGroups)
    .filter((filterGroup) => {
      return !_.some(
        _.map(allFunctions, (functionName) => {
          return functionMatchesGroup(functionName, filterGroup);
        })
      );
    })
    .map((group) => {
      return group.join("-");
    })
    .value();
  if (unmatchedFilters.length > 0) {
    utils.logWarning(
      clc.bold.yellow("functions: ") +
        "the following filters were specified but do not match any functions in the project: " +
        unmatchedFilters.join(", ")
    );
  }
}

/**
 * Creates a map of regions to all the CloudFunctions being deployed
 * to that region.
 * @param projectId The project in use.
 * @param parsedTriggers A list of all CloudFunctions in the deployment.
 */
export function createFunctionsByRegionMap(
  projectId: string,
  parsedTriggers: CloudFunctionTrigger[]
): RegionMap {
  const regionMap: RegionMap = {};
  for (const trigger of parsedTriggers) {
    if (!trigger.regions) {
      trigger.regions = ["us-central1"];
    }
    // Create a separate CloudFunction for
    // each region we deploy a function to
    for (const region of trigger.regions) {
      const triggerDeepCopy = JSON.parse(JSON.stringify(trigger));
      if (triggerDeepCopy.regions) {
        delete triggerDeepCopy.regions;
      }
      triggerDeepCopy.name = [
        "projects",
        projectId,
        "locations",
        region,
        "functions",
        trigger.name,
      ].join("/");
      regionMap[region] = regionMap[region] || [];
      regionMap[region].push(triggerDeepCopy);
    }
  }
  return regionMap;
}

/**
 * Helper method to turn a RegionMap into a flat list of all functions in a deployment.
 * @param regionMap A RegionMap for the deployment.
 */
export function flattenRegionMap(regionMap: RegionMap): CloudFunctionTrigger[] {
  return _.chain(regionMap)
    .map((v: CloudFunctionTrigger[]) => v)
    .flatten()
    .value();
}

/**
 * Create a plan for deploying all functions in one region.
 * @param region The region of this deployment
 * @param functionsInSourceByRegion The functions present in the code currently being deployed.
 * @param existingFunctionNames The names of all functions that already exist.
 * @param existingScheduledFunctionNames The names of all schedules functions that already exist.
 * @param filters The filters, passed in by the user via  `--only functions:`
 */
export function createDeploymentPlan(
  functionsInSourceByRegion: RegionMap,
  existingFunctions: CloudFunctionTrigger[],
  filters: string[][]
): DeploymentPlan {
  const deployment: DeploymentPlan = {
    regionalDeployments: [],
    functionsToDelete: [],
    schedulesToDelete: [],
  };
  for (const region in functionsInSourceByRegion) {
    const regionalDeployment: RegionalDeployment = {
      region,
      functionsToCreate: [],
      functionsToUpdate: [],
      schedulesToCreateOrUpdate: [],
    };
    const localFunctionsInRegion = functionsInSourceByRegion[region];
    for (const fn of localFunctionsInRegion) {
      // Check if this function matches the --only filters
      if (functionMatchesAnyGroup(fn.name, filters)) {
        // Check if this local function has the same name as an exisiting one.
        const matchingExistingFunction = existingFunctions.find((exFn) => {
          return exFn.name === fn.name;
        });
        // Check if the matching exisitng function is scheduled
        const isMatchingExisitingFnScheduled =
          matchingExistingFunction?.labels?.["deployment-scheduled"] === "true";
        // Check if the local function is a scheduled function
        if (fn.schedule) {
          // If the local function is scheduled, set its trigger to the correct pubsub topic
          fn.eventTrigger.resource = getTopicName(fn.name);
          // and create or update a schedule.
          regionalDeployment.schedulesToCreateOrUpdate.push(fn);
        } else if (isMatchingExisitingFnScheduled) {
          // If the local function isn't scheduled but the existing one is, delete the schedule.
          deployment.schedulesToDelete.push(matchingExistingFunction!.name);
        }

        if (!matchingExistingFunction) {
          regionalDeployment.functionsToCreate.push(fn);
        } else {
          regionalDeployment.functionsToUpdate.push(fn);
          existingFunctions = existingFunctions.filter((exFn: CloudFunctionTrigger) => {
            return exFn.name !== fn.name;
          });
        }

      }
    }
    deployment.regionalDeployments.push(regionalDeployment);
  }

  // Delete any remaining existing functions that:
  // 1 - Have the deployment-tool: 'firebase-cli' label and
  // 2 - Match the --only filters, if any are provided.
  const functionsToDelete = existingFunctions.filter((fn) => {
      return deploymentTool.check(fn.labels);
    }).filter((fn) => {
      return filters.length ? functionMatchesAnyGroup(fn.name, filters) : true;
    })
  deployment.functionsToDelete = functionsToDelete.map((fn) => {
    return fn.name;
  });
  // Also delete any schedules for functions that we are deleting.
  for (const fn of functionsToDelete) {
    if (fn.labels?.["deployment-scheduled"] === "true") {
      deployment.schedulesToDelete.push(fn.name);
    }
  }
  return deployment;
}

export function getFunctionTrigger(functionInfo: CloudFunctionTrigger) {
  if (functionInfo.httpsTrigger) {
    return { httpsTrigger: functionInfo.httpsTrigger };
  } else if (functionInfo.eventTrigger) {
    const trigger = functionInfo.eventTrigger;
    trigger.failurePolicy = functionInfo.failurePolicy;
    return { eventTrigger: trigger };
  }

  logger.debug("Unknown trigger type found in:", functionInfo);
  throw new FirebaseError("Could not parse function trigger, unknown trigger type.");
}

export function getFunctionName(fullName: string): string {
  return fullName.split("/")[5];
}

/*
 ** getScheduleName transforms a full function name (projects/blah/locations/blah/functions/blah)
 ** into a job name for cloud scheduler
 ** DANGER: We use the pattern defined here to deploy and delete schedules,
 ** and to display scheduled functions in the Firebase console
 ** If you change this pattern, Firebase console will stop displaying schedule descriptions
 ** and schedules created under the old pattern will no longer be cleaned up correctly
 */
export function getScheduleName(fullName: string, appEngineLocation: string): string {
  const [projectsPrefix, project, regionsPrefix, region, , functionName] = fullName.split("/");
  return `${projectsPrefix}/${project}/${regionsPrefix}/${appEngineLocation}/jobs/firebase-schedule-${functionName}-${region}`;
}

/*
 ** getTopicName transforms a full function name (projects/blah/locations/blah/functions/blah)
 ** into a topic name for pubsub
 ** DANGER: We use the pattern defined here to deploy and delete topics
 ** If you change this pattern, topics created under the old pattern will no longer be cleaned up correctly
 */
export function getTopicName(fullName: string): string {
  const [projectsPrefix, project, , region, , functionName] = fullName.split("/");
  return `${projectsPrefix}/${project}/topics/firebase-schedule-${functionName}-${region}`;
}

export function getRegion(fullName: string): string {
  return fullName.split("/")[3];
}

export function getFunctionLabel(fullName: string): string {
  return getFunctionName(fullName) + "(" + getRegion(fullName) + ")";
}

export function pollDeploys(
  operations: Operation[],
  printSuccess: (op: Operation) => void,
  printFail: (op: Operation) => void,
  printTooManyOps: (projectId: string) => void,
  projectId: string
) {
  let interval;
  // Poll less frequently when there are many operations to avoid hitting read quota.
  // See "Read requests" quota at https://cloud.google.com/console/apis/api/cloudfunctions/quotas
  if (_.size(operations) > 90) {
    printTooManyOps(projectId);
    return Promise.resolve([]);
  } else if (_.size(operations) > 40) {
    interval = 10 * 1000;
  } else if (_.size(operations) > 15) {
    interval = 5 * 1000;
  } else {
    interval = 2 * 1000;
  }
  const pollFunction = cloudfunctions.checkOperation;

  const retryCondition = function (result: Operation) {
    // The error codes from a Google.LongRunning operation follow google.rpc.Code format.

    const retryableCodes = [
      1, // cancelled by client
      4, // deadline exceeded
      10, // aborted (typically due to concurrency issue)
      14, // unavailable
    ];

    if (_.includes(retryableCodes, result.error?.code)) {
      return true;
    }
    return false;
  };

  try {
    return pollOperations.pollAndRetry(
      operations,
      pollFunction,
      interval,
      printSuccess,
      printFail,
      retryCondition
    );
  } catch (err) {
    utils.logWarning(
      clc.bold.yellow("functions:") + " failed to get status of all the deployments"
    );
    logger.info(
      "You can check on their status at " + utils.consoleUrl(projectId, "/functions/logs")
    );
    throw new FirebaseError("Failed to get status of functions deployments.");
  }
}