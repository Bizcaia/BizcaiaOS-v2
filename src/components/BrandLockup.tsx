import { BRAND_LOCKUP_HEIGHT, BRAND_LOCKUP_SRC, BRAND_LOCKUP_WIDTH } from '../brand/lockup';

type Props = {
  className?: string;
};

export default function BrandLockup({ className }: Props) {
  return (
    <img
      className={className}
      src={BRAND_LOCKUP_SRC}
      alt="BizcaiaOS"
      width={BRAND_LOCKUP_WIDTH}
      height={BRAND_LOCKUP_HEIGHT}
      decoding="async"
    />
  );
}
