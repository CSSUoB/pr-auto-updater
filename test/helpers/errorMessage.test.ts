import { errorMessage } from '../../src/helpers/errorMessage';

describe('errorMessage', () => {
  test('returns the message of an Error', () => {
    expect(errorMessage(new Error('something broke'))).toEqual(
      'something broke',
    );
  });

  test('stringifies a thrown value that is not an Error', () => {
    expect(errorMessage('a string throw')).toEqual('a string throw');
    expect(errorMessage(undefined)).toEqual('undefined');
    expect(errorMessage({ code: 1 })).toEqual('[object Object]');
  });
});
