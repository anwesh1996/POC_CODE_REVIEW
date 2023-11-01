const CustomerCreditNoteService = require('./CustomerCreditNoteService');
const { ValidationError } = require('@utils/error');
const { filterErrors, roundOff, isNewItemFlow, checkIfEInvoicingIsApplicable, validateBillOrReferenceNumber, vaildateUnitRate, isItemsValidHsn, getTaxRateForNote,decimalPlaceValidation,isEditCancelAllowed } = require('@utils');
const { CREDIT_NOTE_CREATION_REASONS_META_MAPPING } = require('@lib/constants/note-creation-reasons');
const _ = require('lodash');
const moment = require('moment');
const ObjectId = require('mongoose').Types.ObjectId;
const { APPLICABLE_TCS_SALES_RATES} = require('../../lib/constants/tcsConstants');
class CustomerCreditNoteValidationsService extends CustomerCreditNoteService {
  constructor() {
    super();
  }

  /**
   * Validates the invoice data on save and preview.
   * @param {User} user - The user object.
   * @param {LegalEntity} legalEntity - The legal entity object.
   * @param {InvoiceData} invoiceData - The invoice data object.
   * @param {InvoiceData} oldInvoice - The old invoice data object.
   * @param {boolean} [throwError=true] - Whether to throw an error or not.
   * @returns {Promise<{errors: string[], data: InvoiceData}>}
   */
  validateCustomerCreditNoteForUpdation({ creditNoteId, oldCreditNote, isEdit, throwError = true }) {
    const errors = [];

    if (!isEdit && oldCreditNote.amountPaid > 0) {
      errors.push('Amout paid cannot be greater than 0');
    }

    if (oldCreditNote.status === this.CONSTANTS.STATUSES.DRAFT || oldCreditNote.status === this.CONSTANTS.STATUSES.CANCELLED) {
      errors.push('Cannot submit for e-invoicing as credit note is in draft or cancelled status');
    }
    if (oldCreditNote.irnStatus === this.CONSTANTS.IRN_STATUSES.GENERATED || oldCreditNote.isSubmittedForEInvoicing) {
      errors.push('Cannot submit for e-invoicing as credit note is already submitted for e-invoicing');
    }

    if (oldCreditNote.boqItems && oldCreditNote.boqItems.length) {
      let customItemsTotalValue = oldCreditNote.items.reduce((sum, item) => sum + item.quantity * item.unitRate, 0);
      let boqItemsTotalValue = oldCreditNote.boqItems.reduce((sum, item) => sum + item.quantity * item.unitRate, 0);

      if (Math.abs(Number((customItemsTotalValue - boqItemsTotalValue).toFixed(3))) > 2) {
        errors.push('Custom items total value does not match with linked boq items total value');
      }
    }

    if (oldCreditNote && isNewItemFlow({ items: oldCreditNote.items }) && oldCreditNote.isTcsApplicable && !APPLICABLE_TCS_SALES_RATES.includes(Number(oldCreditNote.tcsRate)) && Number(oldCreditNote.tcsRate) !== 0) {
      throw new ValidationError(
        `Cannot create credit note: Selected TCS Rate is not applicable, please select these tcs rates ${APPLICABLE_TCS_SALES_RATES.join(
          ', '
        )}`
      );
    }

    if (oldCreditNote && isNewItemFlow({ items: oldCreditNote.items }) && !isEditCancelAllowed({oldData:oldCreditNote, newData: oldCreditNote, key: 'noteDate'})) {
      errors.push('Cannot update as Credit Note Date is not allowed by book closure.');
    }

    const filteredErrors = filterErrors(errors);
    if (throwError && filteredErrors.length) {
      throw new ValidationError(filteredErrors.join('\n'));
    }

    return { errors: filteredErrors.length && filteredErrors, data: oldCreditNote };
  }

  checkAmountValidation({ newNoteValue, invoiceAmountDue, creditNoteData, throwError = true }) {
    const errors = [];

    let calculatedAmountDue = invoiceAmountDue;
    creditNoteData.paymentSchedule && creditNoteData.paymentSchedule.find(ps => {
      if (ps.referenceId.toString() === creditNoteData.invoiceId.toString()) {
        calculatedAmountDue += ps.initialTotalAmount;
      }
    });

    if (roundOff(newNoteValue, 2) > roundOff(calculatedAmountDue, 2) && roundOff(newNoteValue, 2) - roundOff(calculatedAmountDue, 2) > 1) {
      errors.push('Credit note value cannot be greater than invoice due amount');
    }

    const filteredErrors = filterErrors(errors);
    if (throwError && filteredErrors.length) {
      throw new ValidationError(filteredErrors.join('\n'));
    }

    return { errors: filteredErrors.length && filteredErrors, data: creditNoteData };
  }

  boqItemsValidations({ customerCreditNoteData, noteReasonMeta, contract, invoice }){
    if(invoice && (!invoice['isCreatedFromBOQ'] || !contract['isBOQRequiredToCreateOrder'])) {
      return;
    }
    if(isNewItemFlow({items: customerCreditNoteData.items}) && (noteReasonMeta.itemsFrom === 'invoice') && contract['boqDetails'] && contract['boqDetails']['lineItems']){
      if((noteReasonMeta.hasInventoryImpact === true && !(customerCreditNoteData.boqItems && customerCreditNoteData.boqItems.length))
      || (noteReasonMeta.hasInventoryImpact === false && !(customerCreditNoteData.noInventoryImpactBOQItems && customerCreditNoteData.noInventoryImpactBOQItems.length))){
        throw new ValidationError('Boq line items should be added');
      }
    }
  }

  async validateCustomerCreditNoteOnSaveAndPreview({ user, legalEntity, creditNoteId, oldCreditNote, customerCreditNoteData, isEdit, throwError = true, invoice, reversedDebitNote, contract, noteReasonMeta }){

    this.boqItemsValidations({ customerCreditNoteData, noteReasonMeta, contract, invoice });
    let isOldCreditNoteNewItems = oldCreditNote && oldCreditNote.items && isNewItemFlow({ items: oldCreditNote.items || [] });
    const errors = [];

    const allowedStatuses = ['PO_ACKNOWLEDGED', 'BILLING_STARTED', 'ORDER_RELEASED', 'BILLING_STOPPED'];
    if(isNewItemFlow({ items: customerCreditNoteData.items }) && noteReasonMeta.documentAcknowledgmentCheck && !allowedStatuses.includes(contract.status)) {
      errors.push('Note for selected reason can not be created as SO is not acknowledged.');
    }
    if(noteReasonMeta.itemsFrom === 'so') {
      let contractQuantityMapper = {};
      contract.items.forEach(eachItem => contractQuantityMapper[String(eachItem._id)] = eachItem);
      customerCreditNoteData.items.forEach(eachItem => {
        if(eachItem.quantity > contractQuantityMapper[String(eachItem.contractLineItemId)].quantity){
          errors.push(`Item ${eachItem.itemCode} quantity (${eachItem.quantity}) can not be greater than contract lineItem quantity.`);
        }
        if(!contract.isUnitRateValidationRequired && 
          !(contractQuantityMapper[String(eachItem.contractLineItemId)].invoiceAllocations 
          && contractQuantityMapper[String(eachItem.contractLineItemId)].invoiceAllocations.length)
          && (eachItem.unitRate < 0.01 || (String(eachItem.unitRate).indexOf('.') > -1 && String(eachItem.unitRate).split('.')[1].length > 2))){
          errors.push(`(${eachItem.name} - ${eachItem.itemCode}) Unit Rate should be positive, not less than 0.01 and can be upto 2 decimal places. Ex: 100.12`);
        }
      });
    }

    if (oldCreditNote && oldCreditNote.status === this.CONSTANTS.STATUSES.CANCELLED) {
      errors.push('Cannot edit credit note as the note is already cancelled.');
    }

    if (!isEdit && oldCreditNote && oldCreditNote.amountPaid > 0) {
      errors.push('Cannot edit credit note as amount already paid.');
    }

    if (oldCreditNote && oldCreditNote.isSubmittedForEInvoicing) {
      errors.push('Cannot edit credit note as it has been submitted einvoicing.');
    }
    if(isNewItemFlow({ items: customerCreditNoteData.items }) && noteReasonMeta.canDeleteItems === false && noteReasonMeta.itemsFrom !== 'custom') {
      if (reversedDebitNote && (customerCreditNoteData.isTcsApplicable !== !!reversedDebitNote.isTcsApplicable || customerCreditNoteData.tcsRate !== (reversedDebitNote.tcsRate|| 0))) {
        errors.push('Can not change tcs value.');
      }
      if (invoice && noteReasonMeta.itemsFrom === 'invoice' && (customerCreditNoteData.isTcsApplicable !== !!invoice.isTcsApplicable || customerCreditNoteData.tcsRate !== (invoice.tcsRate || 0))) {
        errors.push('Can not change tcs value.');
      }
    }

    if ((customerCreditNoteData.boqItems && customerCreditNoteData.boqItems.length) || 
    (customerCreditNoteData.noInventoryImpactBOQItems && customerCreditNoteData.noInventoryImpactBOQItems.length)) {

      const boqItems = (customerCreditNoteData.boqItems && customerCreditNoteData.boqItems.length) ? customerCreditNoteData.boqItems : customerCreditNoteData.noInventoryImpactBOQItems;

      let customItemsTotalValue = customerCreditNoteData.items.reduce((sum, item) => sum + item.quantity * item.unitRate, 0);
      let boqItemsTotalValue = boqItems.reduce((sum, item) => sum + item.quantity * item.unitRate, 0);

      if (Math.abs(Number((customItemsTotalValue - boqItemsTotalValue).toFixed(3))) > 2) {
        errors.push('Custom items total value does not match with linked boq items total value');
      }
    }
    if(contract.isUnitRateValidationRequired || (isNewItemFlow({ items: customerCreditNoteData.items }) && noteReasonMeta.itemsFrom === 'custom')){
      vaildateUnitRate(customerCreditNoteData.items);
    } 

    if(!noteReasonMeta.isHSN_SACCodeRestricted){
      const { invalidHsnErrors } = await isItemsValidHsn({ user, legalEntity, throwError, oldItems: oldCreditNote && oldCreditNote.items, newItems: customerCreditNoteData.items });
      errors.push(...invalidHsnErrors);
    }

    if (isNewItemFlow({ items: customerCreditNoteData.items })) {
      decimalPlaceValidation({ field: 'cessAmount', items: customerCreditNoteData.items });
    }

    const filteredErrors = filterErrors(errors);
    if (throwError && filteredErrors.length) {
      throw new ValidationError(filteredErrors.join('\n'));
    }

    if(invoice){
      return this.services.ContractValidationsService.validateNewNoteNewContractOrInvoiceOrReversalNote({ 
        sourceDocData: invoice, 
        noteData: customerCreditNoteData, 
        message: 'Can not raise old credit note for new invoice.'
      });
    }else if(reversedDebitNote && isNewItemFlow({items: reversedDebitNote.items})){
      return this.services.ContractValidationsService.validateNewNoteNewContractOrInvoiceOrReversalNote({ 
        sourceDocData: reversedDebitNote, 
        noteData: customerCreditNoteData, 
        message: 'Can not raise old credit note for new debit note.'
      });
    } if(contract && (oldCreditNote ? isOldCreditNoteNewItems : true) && !reversedDebitNote && customerCreditNoteData.reason !== 'Reversal of Debit notes (Conditional Qty impact)' ){
      return this.services.ContractValidationsService.validateNewNoteNewContractOrInvoiceOrReversalNote({ 
        sourceDocData: contract, 
        noteData: customerCreditNoteData, 
        message: 'Can not raise old credit note for new contract.'
      });
    }

    return { errors: filteredErrors.length && filteredErrors, data: customerCreditNoteData };
  }

  async validateCustomerCreditNoteOnEdit(user, legalEntity, { oldCustomerCreditNote, newCustomerCreditNote, throwError = true, isApplicableForEInvoicing }) {
    const errors = [];

    if (String(oldCustomerCreditNote.contractDetails.customerId) !== String(newCustomerCreditNote.customerId)) {
      errors.push('Cannot edit Credit Note as Customer is changed');
    }

    const { allDocuments = [] } = await this.services.CustomerFinancePaymentService.findMany({
      findConditions: { creditNoteId: oldCustomerCreditNote._id },
      getAllDocuments: true
    });
    const totalPaidAmount = allDocuments.reduce((sum, fp) => sum + (fp.paidAmount + fp.charges), 0);
    if (totalPaidAmount > newCustomerCreditNote.noteValue) {
      errors.push('Cannot edit Credit Note as paid amount is more than note amount');
    }

    if (oldCustomerCreditNote && oldCustomerCreditNote._id &&  !oldCustomerCreditNote.hasOwnProperty('isSentToMSD')){
      const creditNoteData = await this.services.CustomerCreditNoteService.findById(oldCustomerCreditNote._id, [], true, 'isSentToMSD');
      oldCustomerCreditNote.isSentToMSD = creditNoteData.isSentToMSD;
    }

    if (oldCustomerCreditNote && isApplicableForEInvoicing && isNewItemFlow({ items: oldCustomerCreditNote.items }) && !isEditCancelAllowed({oldData:oldCustomerCreditNote, newData: newCustomerCreditNote, key: 'noteDate'})) {
      errors.push('Cannot update as Credit Note Date is not allowed by book closure.');
    }

    const filteredErrors = filterErrors(errors);
    if (throwError && filteredErrors.length) {
      throw new ValidationError(filteredErrors.join('\n'));
    }

    return { errors: filteredErrors.length && filteredErrors, data: newCustomerCreditNote };
  }

  validatePaymentScheduleData({ paymentScheduleData, creditNote, throwError = true }) {
    const errors = [];

    try {
      const totalAmount = paymentScheduleData.reduce((total, schedule) => {
        return total + schedule.initialTotalAmount;
      }, 0);

      if (Number(totalAmount.toFixed(2)) !== Number(creditNote.roundedOffValue.toFixed(2))) {
        errors.push('Invalid Payment Schedule Data, Sum of payment schedule should match the note value');
      }
    } catch (error) {
      errors.push(error);
    }

    const filteredErrors = filterErrors(errors);
    if (throwError && filteredErrors.length) {
      throw new ValidationError(filteredErrors.join('\n'));
    }
    return { errors: filteredErrors.length && filteredErrors, data: creditNote };
  }

  validateIfPaymentScheduleEditable({ creditNoteId, payments, paymentScheduleData, throwError = true, creditNote }) {
    const errors = [];
    let totalAmountAgainstCreditNote = 0;
    let totalFinancePaymentAmount = 0;
    totalAmountAgainstCreditNote = paymentScheduleData.reduce((sum, schedule) => {
      return schedule.referenceId.toString() === creditNoteId.toString() ? sum + schedule.initialTotalAmount : sum + 0;
    }, 0);
    totalFinancePaymentAmount = payments.reduce((sum, payment) => {
      return sum + payment.amount + payment.charges.reduce(
        (chargeSum, charge) => {
          return chargeSum + charge.amount;
        }
        , 0
      );
    }, 0);
    if (totalAmountAgainstCreditNote < totalFinancePaymentAmount) {
      errors.push('Payment Schedule not editable with given schedule, as total amount against credit note is less than total finance payment for the credit note');
    }

    if (creditNote && creditNote.reversedDebitNoteId) {
      errors.push(`This Credit Note has been used for reversal of Debit Note(${creditNote.reversedDebitNoteDetails.noteNumber}).`);
    }
    if (creditNote && creditNote.reversedByDebitNoteId) {
      errors.push(`Reversal Debit Note(${creditNote.reversedByDebitNoteDetails.noteNumber}) has been created for this Credit Note.`);
    }
    const filteredErrors = filterErrors(errors);
    if (throwError && filteredErrors.length) {
      throw new ValidationError(filteredErrors.join('\n'));
    }
    return { errors: filteredErrors.length && filteredErrors, data: paymentScheduleData };
  }

  ValidateCustomerCreditNoteReasonMapping({customerCreditNoteData, invoice, debiteNote, isEdit, oldCreditNoteData, throwError = true, contract}) {
    const errors = [];
    const { reason, items = [], boqItems, isIntegratedTax, einvoiceSubType } = customerCreditNoteData;

    if (!reason) {
      throw new ValidationError('Reason is required for credit note creation');
    }
    if (!items.length) {
      throw new ValidationError('At least one item is required for credit note creation');
    }
    const noteReasonMeta = CREDIT_NOTE_CREATION_REASONS_META_MAPPING[reason];
    if (!noteReasonMeta) {
      throw new ValidationError(`Mentioned reason '${reason}' does not exist`);
    }

    const invoiceItemsMapById = _.keyBy((invoice && invoice.items) || [], '_id');
    let oldCreditNoteItemsMapById;
    if(noteReasonMeta.itemsFrom === 'invoice' && !invoice) {
      throw new ValidationError('no invoice found');
    }
    if(isEdit && oldCreditNoteData && noteReasonMeta.itemsFrom === 'invoice') {
      oldCreditNoteItemsMapById = _.keyBy(oldCreditNoteData.items, 'invoiceLineItemId');
    }
    const debiteNoteItemsMapById = _.keyBy((debiteNote && debiteNote.items) || [], '_id');
    if(noteReasonMeta.itemsFrom === 'debiteNote') {
      if(!debiteNote) {
        throw new ValidationError('no debit note found');
      }
      if(debiteNote.items && items.length != debiteNote.items.length) {
        errors.push(`items can't be modified for reason: ${reason}`);
      }
    }

    if (invoice && invoice.items && noteReasonMeta.validateAgainstInvoiceUnitRate) {
      for (const item of (customerCreditNoteData.items || [])) {
        if (!item.invoiceLineItemId) {
          continue;
        }
        const invoiceItem = invoiceItemsMapById[item.invoiceLineItemId.toString()];
        if (!invoiceItem) {
          continue;
        }
        const invoiceItemUnitRate = invoiceItem.unitRate;
        if (item.unitRate > invoiceItemUnitRate) {
          errors.push(`Item unit rate (${item.unitRate}) cannot be greater than invoice unit rate (${invoiceItemUnitRate})`);
        }
      }
    }
    // if(noteReasonMeta.sameValueForAllItems) {
    //   const value = items[0].quantity*items[0].unitRate;
    //   if(items.some(item => item.quantity*item.unitRate !== value)) {
    //     errors.push('Value of all the items should be same');
    //   }
    // }
    for(const item of items) {
      if(noteReasonMeta.hasOwnProperty('itemCodeNameMap') && !noteReasonMeta.itemCodeNameMap.hasOwnProperty(item.itemCode)) {
        errors.push(`Mentioned item code: ${item.itemCode} does not match with the credit note reason: ${reason}`);
      }
      if(!(noteReasonMeta.userEditable && noteReasonMeta.userEditable.includes('name')) && noteReasonMeta.hasOwnProperty('itemCodeNameMap') && noteReasonMeta.itemCodeNameMap[item.itemCode] && noteReasonMeta.itemCodeNameMap[item.itemCode] != item.itemName) {
        errors.push(`Item name for all items should be ${noteReasonMeta.itemCodeNameMap[item.itemCode]}`);
      }
      if(noteReasonMeta.hasOwnProperty('HSN_SACCode') && item.itemHsnCode !== noteReasonMeta.HSN_SACCode[0] && item.itemSacCode !== noteReasonMeta.HSN_SACCode[0]) {
        errors.push(`HSN or SAC code for all items should be ${noteReasonMeta.HSN_SACCode[0]}`);
      }
      if(noteReasonMeta.hasOwnProperty('taxRate')) {
        let taxRateToCheck = getTaxRateForNote({ noteReasonMeta, einvoiceSubType, contract });
        if (taxRateToCheck && taxRateToCheck.length) {
          if(isIntegratedTax && !taxRateToCheck.includes(item.igst)) {
            errors.push(`igst for all items should be ${taxRateToCheck.join(' or ')}`);
          }
          if(!isIntegratedTax && (!taxRateToCheck.includes(item.cgst*2) || !taxRateToCheck.includes(item.sgst*2))) {
            errors.push(`cgst and sgst for all items should be ${taxRateToCheck.map(e=>e/2).join(' or ')}`);
          }
        }
      }
      if(noteReasonMeta.hasOwnProperty('defaultQuantity') && item.quantity !== noteReasonMeta.defaultQuantity) {
        errors.push(`quantity for all items should be ${noteReasonMeta.defaultQuantity}`);
      }
      if(noteReasonMeta.hasOwnProperty('defaultUnit') && item.unit !== noteReasonMeta.defaultUnit) {
        errors.push(`unit for all items should be ${noteReasonMeta.defaultUnit}`);
      }

      if(noteReasonMeta.itemsFrom === 'invoice') {
        const invoiceItem = invoiceItemsMapById[item.invoiceLineItemId];
        if(!invoiceItem) {
          errors.push(`no invoice line item found for ${item.name}`);
          continue;
        }
        if(!(boqItems && boqItems.length && item.itemSacCode)) {
          if(noteReasonMeta.hasInventoryImpact && item.quantity > (isEdit && oldCreditNoteItemsMapById[item.invoiceLineItemId] ? invoiceItem.unadjustedQuantity + oldCreditNoteItemsMapById[item.invoiceLineItemId].quantity : invoiceItem.unadjustedQuantity)) {
            errors.push(`quantity of item ${item.name} can't exceed ${(isEdit && oldCreditNoteItemsMapById[item.invoiceLineItemId] ? invoiceItem.unadjustedQuantity + oldCreditNoteItemsMapById[item.invoiceLineItemId].quantity : invoiceItem.unadjustedQuantity)}`);
          } else if(noteReasonMeta.quantityValidation && item.quantity > invoiceItem.quantity) {
            errors.push(`quantity of item ${item.name} can't exceed ${invoiceItem.quantity}`);
          }
        }

        if(!contract.isSegment2Migrated && (item.itemHsnCode !== invoiceItem.itemHsnCode || item.itemSacCode !== invoiceItem.itemSacCode)) {
          errors.push(`hsn/sac code of item ${item.name} does not match with invoice`);
        }
        if(!contract.isSegment2Migrated && (item.cgst != invoiceItem.cgst || item.sgst !== invoiceItem.sgst || item.igst !== invoiceItem.igst)) {
          errors.push(`tax rates(cgst/sgst/igst) of item ${item.name} does not match with invoice`);
        }
        if(item && item.unit !== invoiceItem.unit){
          errors.push(`unit of item '${item.name}' does not match with invoice`);
        }
      }

      if(noteReasonMeta.itemsFrom === 'debiteNote' && debiteNote) {
        const debiteNoteItem = debiteNoteItemsMapById[item._id];
        if(!debiteNoteItem) {
          errors.push(`no item found for ${item.name}`);
          continue;
        }
        if(item.quantity != debiteNoteItem.quantity) {
          errors.push(`quantity of item ${item.name} does not match with credit note`);
        }

        if(!contract.isSegment2Migrated && (item.itemHsnCode !== debiteNoteItem.itemHsnCode || item.itemSacCode !== debiteNoteItem.itemSacCode)) {
          errors.push(`hsn/sac code of item ${item.name} does not match with credit note`);
        }
        if(!contract.isSegment2Migrated && (item.cgst != debiteNoteItem.cgst || item.sgst !== debiteNoteItem.sgst || item.igst !== debiteNoteItem.igst)) {
          errors.push(`tax rates(cgst/sgst/igst) of item ${item.name} does not match with credit note`);
        }
      }

      const filteredErrors = filterErrors(errors);
      if (throwError && filteredErrors.length) {
        throw new ValidationError(filteredErrors.join('\n'));
      }
      return { errors: filteredErrors.length && filteredErrors, data: {customerCreditNoteData}};
    }
  }

  async creditNoteReversalValidations({reversedCreditNote , contractId}){
    let { allDocuments: customerFinancePayments } =
            await this.services.CustomerFinancePaymentService.findMany({
              findConditions: {
                creditNoteId: reversedCreditNote._id,
                status: {
                  $ne: this.services.CustomerFinancePaymentService.CONSTANTS.STATUSES.PAYMENT_FAILED,
                },
              },
              getAllDocuments: true,
            });

    if (customerFinancePayments && customerFinancePayments.length > 0) {
      throw new ValidationError(`Payment is already made for this credit note (${reversedCreditNote.noteNumber})`);
    }
    if(String(contractId) !== String(reversedCreditNote.contractId)){
      throw new ValidationError(`Credit note (${reversedCreditNote.noteNumber}) used for reversal does not belongs to the same contract`);
    }
    if(reversedCreditNote['status'] === this.CONSTANTS.STATUSES.DRAFT 
            || reversedCreditNote['status'] === this.CONSTANTS.STATUSES.CANCELLED){
      throw new ValidationError(`Credit note (${reversedCreditNote.noteNumber}) can not be use as it is in ${reversedCreditNote.status} status`);
    }
    if(reversedCreditNote['reversedByDebitNoteId'] || reversedCreditNote['reversedDebitNoteId']){
      throw new ValidationError(`Credit note (${reversedCreditNote.noteNumber}) is already used for reversal`);
    }
  }

  async validateEInvoicingMandate(user,legalEntity,{reversedCreditNoteId,mapedDocumentIsValidByBookClosure}) {
    const noteData = await this.findById(reversedCreditNoteId,[{
      path: 'contractDetails',
      select: 'customerId zetwerkId',
      populate: ['zetwerkDetail','customerDetails']
    }]);
    const isApplicableForEInvoicing = checkIfEInvoicingIsApplicable(noteData, 'creditNote');
    const skipEInvoiceCheckOnBookClosure = isApplicableForEInvoicing && !mapedDocumentIsValidByBookClosure && isNewItemFlow({ items:noteData.items}) && noteData.irnStatus !== this.services.CustomerCreditNoteService.CONSTANTS.IRN_STATUSES.GENERATED;
    if(!skipEInvoiceCheckOnBookClosure && isApplicableForEInvoicing && isNewItemFlow({items:noteData.items}) && noteData.irnStatus !== this.CONSTANTS.IRN_STATUSES.GENERATED) {
      throw new ValidationError(`E-Invoicing is required for reversal of credit note (${noteData.noteNumber})`);

    }
  }

  async validateReferenceDocNumber(user, legalEntity, { noteId, customerId, referenceNumber, throwError = true }) {
    if (!referenceNumber) {
      return { valid: true, errors: [] };
    }
    if (!customerId && !referenceNumber) {
      throw new ValidationError('Reference number and customer Id is required for duplicate check');
    }

    const customer = await this.services.CustomerService.findById(customerId, [], true, 'customerVerificationType');
    const refDocRegexError = validateBillOrReferenceNumber({ referenceDocumentNumber: referenceNumber, supplierInformation: '', customerInformation: customer, documentType: 'creditNote'});

    let currentYear = moment().year();
    let currentMonth = moment().month();
    if (currentMonth < 3) {
      currentYear -= 1;
    }
    const financialYearStartDate = moment(`${currentYear}-04-01`).startOf('day');
    const financialYearEndDate = moment(`${currentYear + 1}-04-30`).endOf('day');

    let referenceNumbers = await this.distinct('referenceDocumentNumber', {
      ...noteId && noteId && noteId !== 'undefined' && noteId !== 'null' && { _id: { $nin: [noteId] } },
      schemaVersion: '2',
      customerId: new ObjectId(customerId),
      status: { $nin: [this.CONSTANTS.STATUSES.DRAFT, this.CONSTANTS.STATUSES.CANCELLED] },
      noteDate: { $gte: financialYearStartDate, $lte: financialYearEndDate },
      reversedByDebitNoteId: { $exists: false }
    });
    referenceNumbers = (referenceNumbers || []).map(refNo => refNo && refNo.toLowerCase());
    let valid = true, errors = {};
    if (referenceNumbers && referenceNumbers.indexOf(referenceNumber.toLowerCase()) !== -1) {
      valid = false;
      errors['refNumber'] = 'Customer Credit note Reference Number for the customer already exists';
    }

    if (refDocRegexError && refDocRegexError.length) {
      if (errors['refNumber']) {
        errors['refNumber'] += refDocRegexError;
      } else {
        errors['refNumber'] = refDocRegexError;
      }
    }

    const errorMessage = { valid, errors };
    if (!errorMessage.valid && throwError) {
      const errors = [];
      for (const error in errorMessage.errors) {
        errors.push(errorMessage.errors[error]);
      }
      const filteredErrors = filterErrors(errors);
      if (filteredErrors.length) {
        throw new ValidationError(filteredErrors.join('\n'));
      }
    }
    return errorMessage;
  }


  validateCustomerCreditNoteOnCancel({ creditNote, throwError = true }) {
    const errors = [];

    if (creditNote && !isEditCancelAllowed({oldData:creditNote, newData: creditNote, key: 'noteDate'})) {
      errors.push('Cannot cancel as Credit Note Date is not allowed by book closure.');
    }

    const filteredErrors = filterErrors(errors);
    if (throwError && filteredErrors.length) {
      throw new ValidationError(filteredErrors.join('\n'));
    }

    return { errors: filteredErrors.length && filteredErrors, data: creditNote };
  }

}

module.exports = CustomerCreditNoteValidationsService;
