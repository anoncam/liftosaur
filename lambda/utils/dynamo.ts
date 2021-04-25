import { Request, DynamoDB, AWSError } from "aws-sdk";
import { LogUtil } from "./log";

export class DynamoUtil {
  private _dynamo?: DynamoDB.DocumentClient;

  constructor(private readonly log: LogUtil) {}

  private get dynamo(): DynamoDB.DocumentClient {
    if (this._dynamo == null) {
      this._dynamo = new DynamoDB.DocumentClient();
    }
    return this._dynamo;
  }

  public async query<T>(args: {
    tableName: string;
    expression: string;
    indexName?: string;
    scanIndexForward?: boolean;
    attrs?: Record<string, DynamoDB.DocumentClient.AttributeName>;
    values?: Partial<Record<string, string>>;
  }): Promise<T[]> {
    const startTime = Date.now();
    const result = await query<T>((key) => {
      return this.dynamo.query({
        TableName: args.tableName,
        IndexName: args.indexName,
        ExclusiveStartKey: key,
        ScanIndexForward: args.scanIndexForward,
        KeyConditionExpression: args.expression,
        ExpressionAttributeNames: args.attrs,
        ExpressionAttributeValues: args.values,
      });
    });
    this.log.log(
      `Dynamo query: ${args.tableName}${args.indexName ? ` (${args.indexName})` : ""} - `,
      args.expression,
      args.attrs,
      args.values,
      ` - ${Date.now() - startTime}ms`
    );
    return result;
  }

  public async scan<T>(args: { tableName: string }): Promise<T[]> {
    const startTime = Date.now();
    const result = await query<T>((key) => {
      return this.dynamo.scan({ TableName: args.tableName, ExclusiveStartKey: key });
    });
    this.log.log(`Dynamo scan: ${args.tableName} - `, args.tableName, ` - ${Date.now() - startTime}ms`);
    return result;
  }

  public async get<T>(args: { tableName: string; key: DynamoDB.DocumentClient.Key }): Promise<T | undefined> {
    const startTime = Date.now();
    const result = await this.dynamo
      .get({ TableName: args.tableName, Key: args.key })
      .promise()
      .then((r) => r.Item as T | undefined);
    this.log.log(`Dynamo get: ${args.tableName} - `, args.key, ` - ${Date.now() - startTime}ms`);
    return result;
  }

  public async put(args: { tableName: string; item: DynamoDB.DocumentClient.PutItemInputAttributeMap }): Promise<void> {
    const startTime = Date.now();
    await this.dynamo.put({ TableName: args.tableName, Item: args.item }).promise();
    this.log.log(`Dynamo put: ${args.tableName} - `, args.item, ` - ${Date.now() - startTime}ms`);
  }

  public async update(args: {
    tableName: string;
    key: DynamoDB.DocumentClient.Key;
    expression: string;
    values?: Partial<Record<string, unknown>>;
  }): Promise<void> {
    const startTime = Date.now();
    await this.dynamo
      .update({
        TableName: args.tableName,
        Key: args.key,
        UpdateExpression: args.expression,
        ExpressionAttributeValues: args.values,
      })
      .promise();
    this.log.log(
      `Dynamo update: ${args.tableName} - `,
      args.key,
      args.expression,
      args.values,
      ` - ${Date.now() - startTime}ms`
    );
  }

  public async batchDelete(args: { tableName: string; keys: DynamoDB.DocumentClient.Key[] }): Promise<void> {
    const startTime = Date.now();
    await this.dynamo
      .batchWrite({
        RequestItems: {
          [args.tableName]: args.keys.map((key) => ({
            DeleteRequest: {
              Key: key,
            },
          })),
        },
      })
      .promise();
    this.log.log(`Dynamo batch delete: ${args.tableName} - `, args.keys, ` - ${Date.now() - startTime}ms`);
  }

  public async batchPut(args: {
    tableName: string;
    items: DynamoDB.DocumentClient.PutItemInputAttributeMap[];
  }): Promise<void> {
    const startTime = Date.now();
    await this.dynamo
      .batchWrite({
        RequestItems: {
          [args.tableName]: args.items.map((item) => ({
            PutRequest: {
              Item: item,
            },
          })),
        },
      })
      .promise();
    this.log.log(`Dynamo batch put: ${args.tableName}`, `${args.items.length} items`, ` - ${Date.now() - startTime}ms`);
  }
}

async function query<T>(
  cb: (key?: DynamoDB.DocumentClient.Key) => Request<DynamoDB.DocumentClient.QueryOutput, AWSError>
): Promise<T[]> {
  let key: DynamoDB.DocumentClient.Key | undefined;
  let items: DynamoDB.DocumentClient.ItemList = [];
  do {
    const result = await cb(key).promise();
    items = items.concat(result.Items || []);
    key = result.LastEvaluatedKey;
  } while (key);
  return items as T[];
}
