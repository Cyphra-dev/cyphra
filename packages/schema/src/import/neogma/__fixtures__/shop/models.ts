// A shop on neogma 2 (TC39 decorators): customers, orders and products.
import {
  Neogma,
  Node,
  NodeEntity,
  PrimaryKey,
  Property,
  Relationship,
  Type,
  defineRelationshipProperties,
} from "neogma";
import type { Related } from "neogma";

const neogma = new Neogma({ url: "bolt://localhost:7687", username: "neo4j", password: "secret" });

const email = Type.String({ format: "email", maxLength: 254 });

const orderLineProps = defineRelationshipProperties({
  Quantity: { property: "quantity", schema: Type.Integer({ minimum: 1, maximum: 99 }) },
  unitPrice: Type.Number({ minimum: 0 }),
});

@Node({ label: "Customer" })
export class CustomerNode extends NodeEntity {
  @PrimaryKey(Type.String({ format: "uuid" }))
  id!: string;

  @Property(email)
  email!: string;

  @Property(Type.String({ minLength: 1, maxLength: 80 }))
  name!: string;

  @Property(Type.Optional(Type.String({ format: "uri" })))
  website?: string;

  @Property(
    Type.Union([Type.Literal("bronze"), Type.Literal("silver"), Type.Literal("gold")], {
      default: "bronze",
    }),
  )
  tier!: "bronze" | "silver" | "gold";

  @Property(Type.Boolean({ default: false }))
  newsletter!: boolean;

  @Property(Type.String({ format: "date-time" }))
  createdAt!: string;

  @Relationship({ name: "PLACED", direction: "out", model: () => OrderNode })
  Orders!: Related<typeof OrderNode>;

  displayName(): string {
    return `${this.name} <${this.email}>`;
  }

  static async findByEmail(this: typeof Customers, address: string) {
    return this.findOne({ where: { email: address } });
  }
}

@Node({ label: "Order" })
export class OrderNode extends NodeEntity {
  @PrimaryKey(Type.String({ format: "uuid" }))
  id!: string;

  @Property(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("paid"),
      Type.Literal("shipped"),
      Type.Literal("in-transit"),
    ]),
  )
  status!: string;

  @Property(Type.Number({ minimum: 0 }))
  total!: number;

  @Property(Type.Optional(Type.String({ format: "date" })))
  deliveryDate?: string;

  @Property(Type.String({ pattern: "^[A-Z]{2}-[0-9]{6}$" }))
  reference!: string;

  @Relationship({ name: "PLACED", direction: "in", model: () => CustomerNode })
  Customer!: Related<typeof CustomerNode>;

  @Relationship({
    name: "CONTAINS",
    direction: "out",
    model: () => ProductNode,
    properties: orderLineProps,
  })
  Products!: Related<typeof ProductNode, typeof orderLineProps>;
}

@Node({ label: "Product" })
export class ProductNode extends NodeEntity {
  @PrimaryKey(Type.String({ pattern: "^[A-Z0-9-]+$" }))
  sku!: string;

  @Property(Type.String({ minLength: 2 }))
  name!: string;

  @Property(Type.Integer({ minimum: 0, default: 0 }))
  stock!: number;

  @Property(Type.Array(Type.String({ minLength: 1 }), { maxItems: 10 }))
  tags!: string[];

  @Property(Type.Refine(Type.Number({ exclusiveMinimum: 0 }), (n) => Number.isFinite(n)))
  price!: number;

  @Property(Type.Optional(Type.Object({ width: Type.Number(), height: Type.Number() })))
  dimensions?: { width: number; height: number };

  @Relationship({
    name: "CONTAINS",
    direction: "in",
    model: () => OrderNode,
    properties: orderLineProps,
  })
  Orders!: Related<typeof OrderNode, typeof orderLineProps>;
}

export const Customers = neogma.model(CustomerNode);
export const Orders = neogma.model(OrderNode);
export const Products = neogma.model(ProductNode);

Customers.beforeCreate = (customer) => {
  customer.email = customer.email.toLowerCase();
};
