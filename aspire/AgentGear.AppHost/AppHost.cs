var builder = DistributedApplication.CreateBuilder(args);

var mongodb = builder.AddMongoDB("mongodb");
var redis = builder.AddRedis("redis");

var agentApi = builder.AddNodeApp("agent-api", "../../servers/agent-api", "src/index.ts")
    .WithHttpEndpoint(port: 4000, env: "PORT")
    .WithReference(mongodb)
    .WithReference(redis);

var agentWeb = builder.AddViteApp("agent-web", "../../apps/agent-web")
    .WithReference(agentApi)
    .WithEnvironment("VITE_API_URL", agentApi.GetEndpoint("http"));

builder.Build().Run();
