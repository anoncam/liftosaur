import { DynamoDB } from "aws-sdk";
import { IStorage, IHistoryRecord, IProgram, IWeight, ILength, IStats } from "../../src/types";
import { Settings } from "../../src/models/settings";
import { Utils } from "../utils";
import { CollectionUtils } from "../../src/utils/collection";
import { ObjectUtils } from "../../src/utils/object";

const tableNames = {
  dev: {
    users: "lftUsersDev",
    usersGoogleId: "lftUsersGoogleIdDev",
    historyRecords: "lftHistoryRecordsDev",
    historyRecordsDate: "lftHistoryRecordsDateDev",
    stats: "lftStatsDev",
    programs: "lftUserProgramsDev",
  },
  prod: {
    users: "lftUsers",
    usersGoogleId: "lftUsersGoogleId",
    historyRecords: "lftHistoryRecords",
    historyRecordsDate: "lftHistoryRecordsDate",
    stats: "lftStats",
    programs: "lftUserPrograms",
  },
} as const;

export interface IUserDao {
  id: string;
  email: string;
  createdAt: number;
  googleId: string;
  storage: IStorage;
}

export type ILimitedUserDao = Omit<IUserDao, "storage"> & {
  storage: Omit<IUserDao["storage"], "programs" | "history" | "stats">;
};

interface IStatDb {
  name: string;
  value: IWeight | ILength;
  timestamp: number;
  type: "length" | "weight";
}

export class UserDao {
  public static async getByGoogleId(googleId: string): Promise<IUserDao | undefined> {
    const dynamo = new DynamoDB.DocumentClient();
    const env = Utils.getEnv();

    const result = await dynamo
      .query({
        TableName: tableNames[env].users,
        IndexName: tableNames[env].usersGoogleId,
        KeyConditionExpression: "#googleId = :googleId",
        ExpressionAttributeNames: {
          "#googleId": "googleId",
        },
        ExpressionAttributeValues: {
          ":googleId": googleId,
        },
      })
      .promise();

    const items = result.Items;
    const id: string | undefined = items?.[0]?.id;
    if (id != null) {
      return UserDao.getById(id);
    } else {
      return undefined;
    }
  }

  public static build(id: string, googleId: string, email: string): IUserDao {
    return {
      id,
      email,
      googleId,
      createdAt: Date.now(),
      storage: {
        history: [],
        programs: [],
        stats: { weight: {}, length: {} },
        id: 1,
        currentProgramId: undefined,
        version: "0",
        helps: [],
        tempUserId: "",
        settings: Settings.build(),
      },
    };
  }

  public static async store(user: ILimitedUserDao): Promise<void> {
    const dynamo = new DynamoDB.DocumentClient();
    const env = Utils.getEnv();

    await dynamo
      .put({
        TableName: tableNames[env].users,
        Item: user,
      })
      .promise();
  }

  public static async getById(userId: string): Promise<IUserDao | undefined> {
    const dynamo = new DynamoDB.DocumentClient();
    const env = Utils.getEnv();

    const userDao = await dynamo
      .get({
        TableName: tableNames[env].users,
        Key: { id: userId },
      })
      .promise()
      .then((r) => r.Item as ILimitedUserDao | undefined);

    if (userDao != null) {
      const history = await dynamo
        .query({
          TableName: tableNames[env].historyRecords,
          IndexName: tableNames[env].historyRecordsDate,
          KeyConditionExpression: "#userId = :userId",
          ExpressionAttributeNames: {
            "#userId": "userId",
          },
          ExpressionAttributeValues: {
            ":userId": userId,
          },
        })
        .promise()
        .then((r) => (r.Items || []) as IHistoryRecord[]);

      const programs = await dynamo
        .query({
          TableName: tableNames[env].programs,
          KeyConditionExpression: "#userId = :userId",
          ExpressionAttributeNames: {
            "#userId": "userId",
          },
          ExpressionAttributeValues: {
            ":userId": userId,
          },
        })
        .promise()
        .then((r) => (r.Items || []) as IProgram[]);

      const statsDb = await dynamo
        .query({
          TableName: tableNames[env].stats,
          KeyConditionExpression: "#userId = :userId",
          ExpressionAttributeNames: {
            "#userId": "userId",
          },
          ExpressionAttributeValues: {
            ":userId": userId,
          },
        })
        .promise()
        .then((r) => (r.Items || []) as IStatDb[]);
      const stats: IStats = statsDb.reduce<{
        weight: Partial<Record<string, unknown[]>>;
        length: Partial<Record<string, unknown[]>>;
      }>(
        (memo, statDb) => {
          const type = statDb.type;
          const name = statDb.name.split("_")[1];
          memo[type][name] = memo[type][name] || [];
          memo[type][name]!.push({ timestamp: statDb.timestamp, value: statDb.value });
          return memo;
        },
        { weight: {}, length: {} }
      );

      return { ...userDao, storage: { ...userDao.storage, history, programs, stats } };
    } else {
      return undefined;
    }
  }

  public static async saveStorage(user: IUserDao, storage: IStorage): Promise<void> {
    const dynamo = new DynamoDB.DocumentClient();
    const { history, programs, stats, ...userStorage } = storage;
    const env = Utils.getEnv();
    const updatedUser: ILimitedUserDao = { ...user, storage: userStorage };
    const historyUpdates = CollectionUtils.inGroupsOf(23, history).map(async (group) => {
      await dynamo
        .batchWrite({
          RequestItems: {
            [tableNames[env].historyRecords]: group.map((record) => ({
              PutRequest: {
                Item: { ...record, userId: user.id },
              },
            })),
          },
        })
        .promise();
    });
    const programUpdates = CollectionUtils.inGroupsOf(23, programs).map(async (group) => {
      await dynamo
        .batchWrite({
          RequestItems: {
            [tableNames[env].programs]: group.map((record) => ({
              PutRequest: {
                Item: { ...record, userId: user.id },
              },
            })),
          },
        })
        .promise();
    });
    const statsLengthArray: IStatDb[] = ObjectUtils.keys(stats.length).flatMap((key) => {
      const st = stats.length[key] || [];
      return st.map((s) => ({ ...s, name: `${s.timestamp}_${key}`, type: "length" }));
    });
    const statsWeightArray: IStatDb[] = ObjectUtils.keys(stats.weight).flatMap((key) => {
      const st = stats.weight[key] || [];
      return st.map((s) => ({ ...s, name: `${s.timestamp}_${key}`, type: "weight" }));
    });
    const statsArray = statsLengthArray.concat(statsWeightArray);
    const statsUpdates = CollectionUtils.inGroupsOf(23, statsArray).map(async (group) => {
      await dynamo
        .batchWrite({
          RequestItems: {
            [tableNames[env].stats]: group.map((record) => ({
              PutRequest: {
                Item: { ...record, userId: user.id },
              },
            })),
          },
        })
        .promise();
    });

    await Promise.all([UserDao.store(updatedUser), ...historyUpdates, ...programUpdates, ...statsUpdates]);
  }
}
