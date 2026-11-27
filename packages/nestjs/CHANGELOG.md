# @cyphra/nestjs

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

## 0.19.0

## 0.18.0

### Minor Changes

- a1148a6: New package `@cyphra/nestjs`, the NestJS integration: `CyphraModule.forRoot` / `forRootAsync` (global by default, `ConfigService`-friendly `useFactory`, named connections), `@InjectCyphra()` for the generated typed client, `@Transactional()` (an `AsyncLocalStorage` transaction shared by the services a method calls, joined by nested calls and `$transaction`), `CyphraHealthIndicator` for `@nestjs/terminus` 10 to 12, and the driver closed on application shutdown. Supports NestJS 10, 11 and 12. Guide: https://www.cyphra.dev/guides/nestjs
