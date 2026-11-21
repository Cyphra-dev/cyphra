// A neogma 1 app: ModelFactory with revalidator schemas, still accepted by neogma 2.
import { ModelFactory, Neogma } from "neogma";
import type { ModelRelatedNodesI, NeogmaInstance } from "neogma";

export const neogma = new Neogma({
  url: "bolt://localhost:7687",
  username: "neo4j",
  password: "secret",
});

export type OrderProperties = {
  id: string;
  items: number;
  status?: string;
};
export type OrderInstance = NeogmaInstance<OrderProperties, object>;

export const Orders = ModelFactory<OrderProperties>(
  {
    label: "Order",
    schema: {
      id: { type: "string", required: true },
      items: { type: "integer", required: true, minimum: 1 },
      status: { type: "string", enum: ["open", "closed"] },
    },
    primaryKeyField: "id",
  },
  neogma,
);

export type UserProperties = {
  id: string;
  name: string;
  email: string;
  homepage?: string;
  age?: number;
  nicknames?: string[];
  code?: string;
};

export interface UsersRelatedNodesI {
  Orders: ModelRelatedNodesI<typeof Orders, OrderInstance, { Rating: number }, { rating: number }>;
}

export interface UsersMethodsI {
  greeting: (this: UsersInstance) => string;
}

export interface UsersStaticsI {
  label: () => string;
}

export type UsersInstance = NeogmaInstance<UserProperties, UsersRelatedNodesI, UsersMethodsI>;

export const Users = ModelFactory<UserProperties, UsersRelatedNodesI, UsersStaticsI, UsersMethodsI>(
  {
    label: "User",
    schema: {
      id: { type: "string", required: true },
      name: { type: "string", required: true, minLength: 3, allowEmpty: false },
      email: { type: "string", required: true, format: "email", messages: { format: "bad email" } },
      homepage: { type: "string", format: "url" },
      age: { type: "number", minimum: 0, maximum: 150 },
      nicknames: { type: "array", items: { type: "string" }, maxItems: 3 },
      code: { type: "string", pattern: /^[a-z]{3}$/i, conform: (v: string) => v !== "xxx" },
    },
    primaryKeyField: "id",
    relationships: {
      Orders: {
        model: Orders,
        direction: "out",
        name: "CREATES",
        properties: {
          Rating: {
            property: "rating",
            schema: { type: "number", required: true, minimum: 1, maximum: 5 },
          },
        },
      },
    },
    statics: {
      label: () => "User",
    },
    methods: {
      greeting() {
        return `Hello, ${this.name}`;
      },
    },
  },
  neogma,
);

Orders.addRelationships({
  Creator: { model: Users, direction: "in", name: "CREATES" },
});

Users.beforeCreate = (user: UsersInstance) => {
  user.name = user.name.trim();
};
