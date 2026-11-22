/**
 * 题单功能对外出口（core 功能切片样例，见 README.md）。
 *
 * 其他功能与旧模块只能从这里引用题单能力；本目录内部文件互相直接引用。
 */
import { defineFeature } from "../../shared/feature.ts";
import { domainTrainingsRouter } from "./routes.ts";

export const feature = defineFeature({
  name: "trainings",
  router: domainTrainingsRouter,
});

export {
  listDomainTrainings,
  lockTrainingExpansion,
  readDomainTraining,
  resolveDomainTraining,
} from "./access.ts";
export {
  deleteDomainTraining,
  type DomainTrainingInput,
  saveDomainTraining,
} from "./service.ts";
export { copyDomainTraining } from "./copy.ts";
