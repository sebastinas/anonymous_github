import * as mongoose from "mongoose";
import Repository from "../Repository";
import config from "../../config";
import AnonymizedRepositoryModel from "./anonymizedRepositories/anonymizedRepositories.model";

const MONGO_URL = `mongodb://${config.DB_USERNAME}:${config.DB_PASSWORD}@${config.DB_HOSTNAME}:27017/`;

export const database = mongoose.connection;

export async function connect() {
  mongoose.set("useNewUrlParser", true);
  mongoose.set("useFindAndModify", true);
  mongoose.set("useUnifiedTopology", true);

  await mongoose.connect(MONGO_URL + "test", {
    authSource: "admin",
    useCreateIndex: true,
    useFindAndModify: true,
  });

  return database;
}

export async function getRepository(repoId: string) {
  const data = await AnonymizedRepositoryModel.findOne({ repoId });
  if (!data) throw new Error("repo_not_found");
  return new Repository(data);
}