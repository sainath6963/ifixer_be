export interface SavedAddressInput {
  label: string;
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: 'IN';
}

export interface SavedAddressView extends SavedAddressInput {
  id: string;
  isDefault: boolean;
}

export interface AddressBookView {
  version: number;
  addresses: SavedAddressView[];
  limit: number;
}
