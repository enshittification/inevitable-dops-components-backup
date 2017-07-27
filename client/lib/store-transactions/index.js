/**
 * External dependencies
 */
var debug = require( 'debug' )( 'calypso:store-transactions' ),
	isEmpty = require( 'lodash/isEmpty' ),
	Readable = require( 'stream' ).Readable,
	inherits = require( 'inherits' ),
	assign = require( 'lodash/assign' );

/**
 * Internal dependencies
 */
var wpcom = require( 'lib/wp' ).undocumented(),
	paygateLoader = require( 'lib/paygate-loader' ),
	validateCardDetails = require( 'lib/credit-card-details' ).validateCardDetails;

/**
 * Make a purchase on WordPress.com.
 *
 * @returns {Readable} A stream of transaction flow steps.
 *
 * @param {CartValue} cart - The current state of the user's shopping cart.
 * @param {object} cardDetails - The credit card being used for this
 * @param {object} domainDetails - Optional domain registration details if the shopping cart contains a domain registration product
 *   transaction.
 */
function submit( params ) {
	return new TransactionFlow( params );
}

function ValidationError( code, message ) {
	this.code = code;
	this.message = message;
}
inherits( ValidationError, Error );

function TransactionFlow( initialData ) {
	Readable.call( this, { objectMode: true } );
	this._initialData = initialData;
	this._hasStarted = false;
}
inherits( TransactionFlow, Readable );

/**
 * Pushes new data onto the stream. Whenever someone wants to read from the
 * stream of steps, this method will get called because we inherited the
 * functionality of `Readable`.
 *
 * Our goal is to capture the flow of the asynchronous callback functions as a
 * linear sequence of steps. When we get the first request for data, we begin
 * the chain of asynchronous functions. On future requests for data, there is
 * no need to start another asynchronous process, so we just return immediately
 * while the first one finises.
 */
TransactionFlow.prototype._read = function() {
	var paymentMethod,
		paymentHandler;

	if ( this._hasStarted ) {
		return false;
	}
	this._hasStarted = true;

	paymentMethod = this._initialData.payment.paymentMethod;
	paymentHandler = this._paymentHandlers[ paymentMethod ];
	if ( ! paymentHandler ) {
		throw new Error( 'Invalid payment method: ' + paymentMethod );
	}

	paymentHandler.call( this );
};

TransactionFlow.prototype._pushStep = function( options ) {
	var defaults = {
		first: false,
		last: false,
		timestamp: Date.now()
	};

	this.push( assign( defaults, options ) );
}

TransactionFlow.prototype._paymentHandlers = {
	WPCOM_Billing_MoneyPress_Stored: function() {
		this._pushStep( { name: 'input-validation', first: true } );
		debug( 'submitting transaction with stored card' );
		this._submitWithPayment( {
			payment_method: 'WPCOM_Billing_MoneyPress_Stored',
			payment_key: this._initialData.payment.moneyPressReference
		} );
	},

	WPCOM_Billing_MoneyPress_Paygate: function() {
		var validation = validateCardDetails( this._initialData.payment.newCardDetails );
		if ( ! isEmpty( validation.errors ) ) {
			this._pushStep( {
				name: 'input-validation',
				error: new ValidationError( 'invalid-card-details', validation.errors ),
				first: true,
				last: true
			} );
			return;
		}

		this._pushStep( { name: 'input-validation', first: true } );
		debug( 'submitting transaction with new card' );
		this._createPaygateToken( function( paygateToken ) {
			this._submitWithPayment( {
				payment_method: 'WPCOM_Billing_MoneyPress_Paygate',
				payment_key: paygateToken
			} );
		}.bind( this ) );
	},

	WPCOM_Billing_WPCOM: function() {
		this._pushStep( { name: 'input-validation', first: true } );
		this._submitWithPayment( { payment_method: 'WPCOM_Billing_WPCOM' } );
	}
};

TransactionFlow.prototype._createPaygateToken = function( callback ) {
	this._pushStep( { name: 'submitting-payment-key-request' } );

	createPaygateToken( this._initialData.payment.newCardDetails, function( error, paygateToken ) {
		if ( error ) {
			return this._pushStep( {
				name: 'received-payment-key-response',
				error: error,
				last: true
			} );
		}

		this._pushStep( { name: 'received-payment-key-response' } );
		callback( paygateToken );
	}.bind( this ) );
};

TransactionFlow.prototype._submitWithPayment = function( payment ) {
	var onComplete = this.push.bind( this, null ), // End the stream when the transaction has finished
		transaction = {
			cart: this._initialData.cart,
			domain_details: this._initialData.domainDetails,
			payment: payment
		};

	this._pushStep( { name: 'submitting-wpcom-request' } );

	wpcom.transactions( 'POST', transaction, function( error, data ) {
		if ( error ) {
			return this._pushStep( {
				name: 'received-wpcom-response',
				error: error,
				last: true
			} );
		}

		this._pushStep( {
			name: 'received-wpcom-response',
			data: data,
			last: true
		} );
		onComplete();
	}.bind( this ) );
};

function createPaygateToken( cardDetails, callback ) {
	paygateLoader.ready( function( error, Paygate ) {
		var parameters;
		if ( error ) {
			callback( error );
			return;
		}

		parameters = getPaygateParameters( cardDetails );
		Paygate.createToken( parameters, onSuccess, onFailure );
	} );

	function onSuccess( data ) {
		if ( data.is_error ) {
			return callback( new Error( 'Paygate Response Error: ' + data.error_msg ) );
		}

		callback( null, data.token );
	}

	function onFailure() {
		callback( new Error( 'Paygate Request Error' ) );
	}
}

function getPaygateParameters( cardDetails ) {
	return {
		name: cardDetails.name,
		number: cardDetails.number,
		cvc: cardDetails.cvv,
		zip: cardDetails['postal-code'],
		exp_month: cardDetails['expiration-date'].substring( 0, 2 ),
		exp_year: '20' + cardDetails['expiration-date'].substring( 3, 5 )
	};
}

function hasDomainDetails( transaction ) {
	return ! isEmpty( transaction.domainDetails );
}

function newCardPayment( newCardDetails ) {
	return {
		paymentMethod: 'WPCOM_Billing_MoneyPress_Paygate',
		newCardDetails: newCardDetails || {}
	};
}

function storedCardPayment( storedCard ) {
	return {
		paymentMethod: 'WPCOM_Billing_MoneyPress_Stored',
		moneyPressReference: storedCard.mp_ref
	};
}

function fullCreditsPayment() {
	return { paymentMethod: 'WPCOM_Billing_WPCOM' };
}

module.exports = {
	hasDomainDetails: hasDomainDetails,
	submit: submit,
	newCardPayment: newCardPayment,
	storedCardPayment: storedCardPayment,
	fullCreditsPayment: fullCreditsPayment,
	createPaygateToken: createPaygateToken // added so we can independently create paygate ref
};
