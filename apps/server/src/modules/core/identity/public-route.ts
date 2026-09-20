import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'meter:public-route';

/** Opt a route out of authentication. Everything unannotated is protected. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
