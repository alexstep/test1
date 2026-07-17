import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PASSWORD_PREHASH_REGEX } from '@/auth/password-prehash';

@ValidatorConstraint({ name: 'isPasswordPrehash', async: false })
export class IsPasswordPrehashConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && PASSWORD_PREHASH_REGEX.test(value);
  }

  defaultMessage(): string {
    return 'password must be a SHA-256 hex digest (64 lowercase hex characters)';
  }
}

export function IsPasswordPrehash(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsPasswordPrehashConstraint,
    });
  };
}
